const axios = require('axios');
const getObjectWithAttributesThatChanged = require('get-object-with-attributes-that-changed');
const changeNameOfAllKeys = require('change-name-of-all-keys');

const Sequelize = require('../models').Sequelize;
const sequelize = require('../models').sequelize;

const { OMS_URL, OMS_SPECIFIC_RUN } = require('../config/config')[
    process.env.ENV || 'development'
];
const {
    create_oms_lumisections,
    create_rr_lumisections,
    update_oms_lumisections,
    update_rr_lumisections
} = require('./lumisection');
const { update_or_create_dataset } = require('./dataset');
const { fill_dataset_triplet_cache } = require('./dataset_triplet_cache');
const { manually_update_a_run } = require('../cron/2.save_or_update_runs');
const {
    create_offline_waiting_datasets
} = require('../cron_datasets/1.create_datasets');
const {
    Run,
    Dataset,
    DatasetTripletCache,
    Event,
    RunEvent
} = require('../models');

const update_or_create_run = async (
    run_number,
    oms_metadata,
    rr_metadata,
    req,
    transaction
) => {
    run_number = +run_number;
    const by = req.email || req.get('email');
    const comment = req.comment || req.get('comment');
    if (!by) {
        throw "The email of the author's action should be stated in request's header 'email'";
    }
    // Start transaction:
    let local_transaction = false;
    try {
        if (typeof transaction === 'undefined') {
            local_transaction = true;
            transaction = await sequelize.transaction();
        }
        const event = await Event.create(
            {
                by,
                comment
            },
            { transaction }
        );

        const runEvent = await RunEvent.create(
            {
                run_number,
                oms_metadata,
                rr_metadata,
                version: event.version,
                deleted: false
            },
            { transaction }
        );
        // update the Run table, we are creating temporary tables to prevent the postgres optimizer to do unnecessary scans of whole table
        await sequelize.query(
            `
                CREATE TEMPORARY TABLE updated_runnumbers as SELECT DISTINCT "run_number" from "RunEvent" where "RunEvent"."version" > (SELECT COALESCE((SELECT MAX("version") from "Run"), 0));
                CREATE TEMPORARY TABLE updated_runs as SELECT * FROM "RunEvent"
                WHERE "RunEvent"."run_number" IN (
                    SELECT * from updated_runnumbers
                );

                INSERT INTO "Run" (run_number, rr_attributes, oms_attributes, deleted, "version")
                SELECT run_number,
                        mergejsonb(rr_metadata ORDER BY version),
                        mergejsonb(oms_metadata ORDER BY version),
                        (SELECT deleted from "RunEvent" WHERE "version" = (SELECT max(version) FROM updated_runs)) AS "deleted",
                        (SELECT max(version) FROM "RunEvent" ) AS "version"
                FROM updated_runs
                GROUP BY run_number
                ON CONFLICT (run_number) DO UPDATE SET "rr_attributes" = EXCLUDED."rr_attributes", "oms_attributes" = EXCLUDED."oms_attributes", "deleted" = EXCLUDED."deleted", "version" = EXCLUDED.version;
            
                DROP TABLE updated_runnumbers;
                DROP TABLE updated_runs;
        `,
            { transaction }
        );
        if (local_transaction) {
            await transaction.commit();
        }
        return runEvent;
    } catch (err) {
        // Rollback transaction if any errors were encountered
        console.log(err);
        if (local_transaction) {
            await transaction.rollback();
        }
        throw `Error updating/saving run ${run_number}, ${err.message}`;
    }
};

const { Op } = Sequelize;
const conversion_operator = {
    and: Op.and,
    or: Op.or,
    '>': Op.gt,
    '<': Op.lt,
    '>=': Op.gte,
    '<=': Op.lte,
    like: Op.iLike,
    notlike: Op.notLike,
    '=': Op.eq,
    '<>': Op.ne,
    // In uppercase as well:
    AND: Op.and,
    OR: Op.or,
    LIKE: Op.iLike,
    NOTLIKE: Op.notLike
};

exports.getAll = async (req, res) => {
    const runs = await Run.findAll({
        order: [['run_number', 'DESC']]
    });
    res.json(runs);
};

exports.getOne = async (req, res) => {
    const run = await Run.findByPk(req.params.run_number);
    res.json(run);
};

exports.get50 = async (req, res) => {
    const runs = await Run.findAll({
        order: [['run_number', 'DESC']],
        limit: 50
    });
    res.json(runs);
};

exports.getRunWithHistory = async (req, res) => {
    let run_events = await RunEvent.findAll({
        where: {
            run_number: req.params.run_number
        },
        order: [['version', 'ASC']],
        include: [{ model: Event }]
    });
    run_events = run_events.map(
        ({ oms_metadata, rr_metadata, run_number, version, Event }) => ({
            ...oms_metadata,
            ...rr_metadata,
            run_number,
            version,
            ...Event.dataValues
        })
    );
    res.json(run_events);
};

exports.new = async (req, res) => {
    // TODO: validate run attributes
    const {
        oms_attributes,
        rr_attributes,
        oms_lumisections,
        rr_lumisections
    } = req.body;
    const { run_number } = oms_attributes;
    const run = await Run.findByPk(run_number);
    if (run !== null) {
        throw 'Run already exists';
    }
    let transaction;
    try {
        const transaction = await sequelize.transaction();
        const runEvent = await update_or_create_run(
            run_number,
            oms_attributes,
            rr_attributes,
            req,
            transaction
        );
        const datasetEvent = await update_or_create_dataset(
            'online',
            run_number,
            {},
            req,
            transaction
        );
        if (rr_lumisections.length > 0) {
            const saved_oms_lumisections = await create_oms_lumisections(
                run_number,
                'online',
                oms_lumisections,
                req,
                transaction
            );

            const saved_rr_lumisections = await create_rr_lumisections(
                run_number,
                'online',
                rr_lumisections,
                req,
                transaction
            );
        }
        await transaction.commit();
        // You can only fill the cache when transaction has commited:
        await fill_dataset_triplet_cache();
        res.json(runEvent);
    } catch (err) {
        console.log(err);
        await transaction.rollback();
        throw `Error saving run ${run_number}`;
    }
};

// This edits or updates the run
// The new_attributes are a collection of the attributes that changed with respect to the run
exports.edit = async (req, res) => {
    const { run_number } = req.params;

    const run = await Run.findByPk(run_number);
    if (run === null) {
        throw 'Run not found';
    }
    const { oms_attributes, rr_attributes } = run.dataValues;
    if (rr_attributes.state !== 'OPEN') {
        throw 'Run must be in state OPEN to be edited';
    }

    let transaction;
    try {
        // If there was a change in the lumisections, we also update the dataset triplet cache

        transaction = await sequelize.transaction();
        // Lumisection stuff:
        const { oms_lumisections, rr_lumisections } = req.body;
        const newRRLumisectionRanges = await update_rr_lumisections(
            run_number,
            'online',
            rr_lumisections,
            req,
            transaction
        );
        if (newRRLumisectionRanges.length > 0) {
            // There was a change in the lumisections, so we should update oms lumisections as well:
            const newOMSLumisectionRange = await update_oms_lumisections(
                run_number,
                'online',
                oms_lumisections,
                req,
                transaction
            );
            // Bump the version in the dataset so the fill_dataset_triplet_cache will know that the lumisections inside it changed, and so can refill the cache:
            const datasetEvent = await update_or_create_dataset(
                'online',
                run_number,
                {},
                req,
                transaction
            );
        }

        // Run stuff:

        const new_oms_attributes = getObjectWithAttributesThatChanged(
            oms_attributes,
            req.body.oms_attributes
        );
        const new_rr_attributes = getObjectWithAttributesThatChanged(
            rr_attributes,
            req.body.rr_attributes
        );
        const new_rr_attributes_length = Object.keys(new_rr_attributes).length;
        // If there was actually something to update in the RR attributes, we update it, if it was a change in oms_attributes, we don't update it (since it doesn't affect RR attributes)
        if (new_rr_attributes_length > 0) {
            const runEvent = await update_or_create_run(
                run_number,
                new_oms_attributes,
                new_rr_attributes,
                req,
                transaction
            );
            //  if there was a change with regards to the RR triplets, if so, save them, or if there was a change with regards to the Run attributes (class, state, significant then save as well the different lumisections)

            // await update_dataset... (which will be the same method to update dataset from OFFLINE)
            // Now that it is commited we should find the updated run:
            console.log(`updated run ${run_number}`);
        }
        await transaction.commit();
        await fill_dataset_triplet_cache();
        const run = await Run.findByPk(run_number);
        res.json(run.dataValues);
    } catch (err) {
        console.log(err);
        await transaction.rollback();
        throw `Error updating run ${run_number}`;
    }
};

exports.markSignificant = async (req, res) => {
    const { run_number } = req.body.original_run;
    const run = await Run.findByPk(run_number);
    if (run === null) {
        throw 'Run not found';
    }
    if (run.rr_attributes.state !== 'OPEN') {
        throw 'Run must be in state OPEN to be marked significant';
    }
    if (run.rr_attributes.significant === true) {
        throw 'Run is already significant';
    }

    const oms_metadata = {};
    const rr_metadata = { significant: true };
    await update_or_create_run(run_number, oms_metadata, rr_metadata, req);
    // We do this to make sure the LUMISECTIONS classification are there
    await manually_update_a_run(run_number, {
        email,
        manually_significant: true,
        comment: `${email} marked run significant, component statuses refreshed`
    });
    res.json(run);
};

exports.refreshRunClassAndComponents = async (req, res) => {
    const { run_number } = req.params;
    const email = `auto - refresh by ${req.get('email')}`;
    const previously_saved_run = await Run.findByPk(run_number);
    if (previously_saved_run.rr_attributes.state !== 'OPEN') {
        throw 'Run must be in state OPEN to be refreshed';
    }

    await manually_update_a_run([fetched_run[0].attributes], {
        email,
        comment: `${email} requested refresh from OMS`
    });
    const saved_run = await Run.findByPk(run_number);
    res.json(saved_run);
};

// TODO: finish moveRun creation of dataset

exports.moveRun = async (req, res) => {
    const { to_state } = req.params;
    const { run_number } = req.body.original_run;
    const run = await Run.findByPk(run_number);
    // Validation
    if (!['SIGNOFF', 'OPEN', 'COMPLETED'].includes(to_state)) {
        throw 'The final state must be SIGNOFF, OPEN OR COMPLETED, no other option is valid';
    }
    if (run.rr_attributes.state === to_state) {
        throw `Run's state is already in state ${to_state}`;
    }
    //      Check if triplets are empty quotes:
    for (const [run_property, value] of Object.entries(
        run.dataValues.rr_attributes
    )) {
        if (run_property.includes('_triplet')) {
            if (
                to_state === 'SIGNOFF' &&
                (value.status === 'NO VALUE FOUND' || value.status === '')
            ) {
                throw `The status of ${
                    run_property.split('_triplet')[0]
                } must not be empty`;
            }
        }
    }
    //      Check if run class is empty:
    if (run.dataValues.rr_attributes.class === '') {
        throw 'The class of run must not be empty ';
    }
    // End validation
    const oms_metadata = {};
    const rr_metadata = { state: to_state };
    let transaction;
    try {
        transaction = await sequelize.transaction();
        await update_or_create_run(
            run_number,
            oms_metadata,
            rr_metadata,
            req,
            transaction
        );

        if (to_state === 'SIGNOFF' || to_state === 'COMPLETED') {
            await create_offline_waiting_datasets(run.dataValues, transaction);
        }
        await transaction.commit();
        await fill_dataset_triplet_cache();
        const saved_run = await Run.findByPk(run_number, {
            include: [
                {
                    model: DatasetTripletCache,
                    attributes: ['triplet_summary']
                }
            ]
        });
        res.json(saved_run.dataValues);
    } catch (e) {
        console.log(e);
        await transaction.rollback();
        throw `Error SIGNING OFF run, creating the datasets from run in OFFLINE`;
    }
};

// Separate filtering and count will make the UX much faster.
exports.getFilteredOrdered = async (req, res) => {
    const { sortings, page_size } = req.body;
    let filter = {
        ...changeNameOfAllKeys(req.body.filter, conversion_operator),
        deleted: false
    };
    const { page } = req.params;
    let offset = page_size * page;
    // findAndCountAll is slower than doing separate count, and filtering
    const count = await Run.count({ where: filter });
    let pages = Math.ceil(count / page_size);
    let runs = await Run.findAll({
        where: filter,
        order: sortings.length > 0 ? sortings : [['run_number', 'DESC']],
        limit: page_size,
        offset,
        include: [
            {
                model: DatasetTripletCache,
                attributes: ['triplet_summary']
            }
        ]
    });

    res.json({ runs, pages });
};

exports.significantRunsFilteredOrdered = async (req, res) => {
    let filter = {
        ...changeNameOfAllKeys(req.body.filter, conversion_operator),
        'rr_attributes.significant': true,
        deleted: false
    };
    let { sortings } = req.body;
    const { page_size } = req.body;
    const { page } = req.params;
    const count = await Run.count({
        where: filter
    });
    let pages = Math.ceil(count / page_size);
    let offset = page_size * page;
    const runs = await Run.findAll({
        where: filter,
        order: sortings.length > 0 ? sortings : [['run_number', 'DESC']],
        limit: page_size,
        offset,
        include: [
            {
                model: DatasetTripletCache,
                attributes: ['triplet_summary']
            }
        ]
    });
    res.json({ runs, pages });
};
