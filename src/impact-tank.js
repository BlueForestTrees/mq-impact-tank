const {getBranches, checkUpserts, forEach} = require("./util")

const ENV = require("./env")
const db = require("mongo-registry")
const rbmq = require("simple-rbmq")
const dbRegistry = require('./dbRegistry')

let tanksDetails = null
let tanks = null
let tanksName = null

const initCollections = () => {
    tanksDetails = db.col(ENV.DB_COLLECTION_DETAILS)
    tanks = db.col(ENV.DB_COLLECTION)
    tanksName = ENV.DB_COLLECTION
}

db.dbInit(ENV, dbRegistry)
    .then(() => rbmq.initRabbit(ENV.RB))
    .then(initCollections)
    .then(() => Promise.all([
        rbmq.createReceiver(ENV.RB.exchange, `impact-upsert`, {...ENV.QUEUE, name: `impact-tank-upsert`}, onImpactUpsert),
        rbmq.createReceiver(ENV.RB.exchange, `impact-delete`, {...ENV.QUEUE, name: `impact-tank-delete`}, onImpactDelete),
        rbmq.createReceiver(ENV.RB.exchange, `root-upsert`, {...ENV.QUEUE, name: `root-impact-tank-upsert`}, onRootUpsert),
        rbmq.createReceiver(ENV.RB.exchange, `root-delete`, {...ENV.QUEUE, name: `root-impact-tank-delete`}, onRootDelete),
    ]))
    .catch(console.error)

const onImpactUpsert = msg => upsertImpactTankDetail(msg).then(updateImpactTank)
const onImpactDelete = msg => deleteImpactTankDetail(msg).then(deleteImpactTank).then(updateImpactTank)
const onRootUpsert = msg => upsertImpactTankDetails(msg).then(updateImpactTank)
const onRootDelete = msg => deleteImpactTankDetails(msg).then(deleteImpactTank).then(updateImpactTank)

//trunk += impact => trunk.branches += impact
const upsertImpactTankDetail = async impact => {
    const branches = await getBranches(impact.trunkId)
    const writes = []
    forEach(branches, ({trunkId, bqt}) =>
        writes.push({
            updateOne: {
                filter: {trunkId, linkId: impact._id},
                update: {$set: {impactId: impact.impactId, rootId: impact.trunkId, bqt: impact.bqt / bqt, dateUpdate: new Date()}},
                upsert: true
            }
        }))
    if (writes.length) {
        await tanksDetails.bulkWrite(writes, {ordered: false}).then(checkUpserts(writes.length))
    } else {
        console.error("no trunk#", impact.trunkId, "to add impact#", impact.impactId)
    }
    return {branchesId: branches.map(b => b.trunkId), impactsId: [impact.impactId]}
}

//trunk -= impact => trunk.branches -= impact
const deleteImpactTankDetail = async impact => {
    const branchesId = (await getBranches(impact.trunkId)).map(b => b.trunkId)
    const impactsId = [impact.impactId]

    await tanksDetails.deleteMany({trunkId: {$in: branchesId}, linkId: impact._id})

    return {branchesId, impactsId}
}

//trunk += root => trunk.branches.impactTank += root.impactTank
const upsertImpactTankDetails = async ({trunkId, rootId, bqt}) => {
    const branches = await getBranches(trunkId, 1 / bqt)
    const rootImpactTank = await tanksDetails.find({trunkId: rootId}).toArray()
    const writes = []
    forEach(branches, branch =>
        forEach(rootImpactTank, ({impactId, linkId, bqt}) =>
            writes.push({
                updateOne: {
                    filter: {trunkId: branch.trunkId, linkId},
                    update: {$set: {trunkId: branch.trunkId, impactId, linkId, bqt: bqt / branch.bqt, rootId, dateUpdate: new Date()}},
                    upsert: true
                }
            })
        )
    )

    if (writes.length) {
        await tanksDetails.bulkWrite(writes, {ordered: false}).then(checkUpserts(writes.length))
    } else if (!branches || !branches.length) {
        console.error("no trunk", trunkId, " to add root.impactTank")
    }

    return {branchesId: branches.map(b => b.trunkId), impactsId: rootImpactTank.map(rtd => rtd.impactId)}
}

//trunk -= root => trunk.branches.impactTank -= root.impactTank
const deleteImpactTankDetails = async ({rootId, trunkId}) => {
    const branchesId = (await getBranches(trunkId)).map(b => b.trunkId)
    const impactsId = await tanks.distinct("impactId", {trunkId: rootId})
    const linksId = await tanksDetails.distinct("linkId", {trunkId: rootId})

    await tanksDetails.deleteMany({trunkId: {$in: branchesId}, linkId: {$in: linksId}})

    return {branchesId, impactsId}
}

const deleteImpactTank = ({branchesId, impactsId}) => tanks
    .deleteMany({trunkId: {$in: branchesId}, impactId: {$in: impactsId}})
    .then(() => ({branchesId, impactsId}))


const updateImpactTank = ({branchesId, impactsId}) => tanksDetails.aggregate([
    {$match: {trunkId: {$in: branchesId}, impactId: {$in: impactsId}}},
    {$group: {_id: {trunkId: "$trunkId", impactId: "$impactId"}, bqt: {$sum: "$bqt"}}},
    {$project: {_id: 0, trunkId: "$_id.trunkId", impactId: "$_id.impactId", bqt: "$bqt", dateUpdate: new Date()}},
    {$out: {to: tanksName, mode: "replaceDocuments", uniqueKey: {trunkId: 1, impactId: 1}}}
]).toArray()