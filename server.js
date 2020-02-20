var express = require('express'),
    app = express(),
    bodyParser = require('body-parser'),
    MongoClient = require('mongodb').MongoClient,
    engines = require('consolidate'),
    assert = require('assert'),
    ObjectId = require('mongodb').ObjectID;

var AWS = require('aws-sdk');

//Pagination init
const paginate = require('express-paginate');
app.use(paginate.middleware(10, 50));

//SecretsManager
var region = "ap-southeast-1";
var docDBSecretName = "DocDBConnectionString";
var RedisSecretName = "RedisURL";
var sConnectionString;

// Redis cache
var cacheEnabled = 1;
//var cacheEnabled = 0;
var redis = require('redis');

var sRedisURL;
var RedisClient;
var bluebird = require('bluebird');

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

// Express initialization
app.use(express.static(__dirname + "/public"));

app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

app.engine('html', engines.nunjucks);
app.set('view engine', 'html');
app.set('views', __dirname + '/views');

function errorHandler(err, req, res, next) {
    console.error(err.message);
    console.error(err.stack);
    res.status(500).render("error_template", { error: err});
}


async function main(){
    // Connect to SecretsManager to get RedisURL and DocDBConnectionString
    try {
        var client = new AWS.SecretsManager({
            region: region
        });

        // Get RedisURL
        var resultGetSecret = await client.getSecretValue({SecretId: RedisSecretName}).promise();
        if (resultGetSecret) {
            sRedisURL = (JSON.parse(resultGetSecret.SecretString))[RedisSecretName];
            console.log("RedisURL = " + sRedisURL);
        }
        
        // Get docDBConnectionString
        var resultGetSecret = await client.getSecretValue({SecretId: docDBSecretName}).promise();
        if (resultGetSecret) {
            sConnectionString = (JSON.parse(resultGetSecret.SecretString))[docDBSecretName];
            console.log("docDB connection string = " + sConnectionString);
        }    
    } catch (err) {
        console.log(err);
    }

    // Connect to Redis cache
    try {
        RedisClient = redis.createClient(6379, sRedisURL);
        await RedisClient.flushallAsync();
    } catch (err) {
        Console.log(err);
    }

    // Connect to CosmosDB using the retrieved connection string
    MongoClient.connect(sConnectionString, function(err, db){
        assert.equal(null, err);
        console.log('Successfully connected to MongoDB.');
    
        var records_collection = db.collection('records');
        var noOfRecords, pageCount, cacheResult, nCurrentPage;
        var bFlushLastPage = false;
        var nRecordsPerPage;
        var nPageToRefresh = 0;
    
        app.get('/records', async function(req, res, next) {
            // console.log("Received get /records request");
            // Query only the records on current page
            nCurrentPage = req.query.page;
            if (cacheEnabled) {
                //console.log("pageCount = " + pageCount + " page requested = " + nCurrentPage + " flush =" + bFlushLastPage + " no of records = " + noOfRecords + " page to refresh = " + nPageToRefresh);
                // If current page is not the last page, and bFlushLastPage is not flagged (i.e, no new record added)
                // and the current page is not updated -> query cache
                if (!((pageCount === req.query.page)&&(bFlushLastPage)) && (nCurrentPage != nPageToRefresh)) {
                    cacheResult = await RedisClient.getAsync(req.query.page);
                    if (cacheResult) {
                        console.log("Cache hit, page = " + req.query.page);
                        //console.log("Cached result = " + cacheResult);
                        bFlushLastPage = false; // reset last page flag
                        nPageToRefresh = 0; // reset page to refresh
                        return res.json(JSON.parse(cacheResult));
                    }
                }
            }
            
            console.log("Cache missed, querying DB");
            results = records_collection.find({}).limit(req.query.limit).skip(req.skip);
            records_collection.count({}, function(error, noOfDocs){
                if (error) console.log(error.message);
                
                noOfRecords = noOfDocs;
                pageCount = Math.ceil(noOfRecords / req.query.limit);
                nRecordsPerPage = req.query.limit;
            });
            
            results.toArray(async function(err, records){
                if(err) throw err;
    
                if(records.length < 1) {
                    console.log("No records found.");
                }
    
                // console.log(records);
                await RedisClient.set(req.query.page, JSON.stringify({
                    recs: records,
                    pgCount: pageCount,
                    itemCount: noOfRecords
                    }));

                res.json({
                    recs: records,
                    pgCount: pageCount,
                    itemCount: noOfRecords
                    //pages: paginate.getArrayPages(req)(3, pageCount, req.query.page)
                });
            });
        });
    
        app.post('/records', function(req, res, next){
            console.log(req.body);
            records_collection.insert(req.body, async function(err, doc) {
                if(err) throw err;
                console.log(doc);

                // clear cache
                //console.log("DB changed, clearing cache!");
                //await RedisClient.flushall();
                
                // Flush cache strategy:
                // - If current page is last page, check if the page is cached, if yes, flag the page to be invalidated. On the next GET request, we will need to bypass the cache
                // - If the added record belongs to new page, notify the server to bypass cache for the next GET (we need to query DB to get new number of records and pages)
                noOfRecords++;
                var nNewPageCount = Math.ceil(noOfRecords / nRecordsPerPage);
                if (nNewPageCount === pageCount) { // record added on the same page
                    pageCount = nNewPageCount;
                    var reply = await RedisClient.existsAsync(pageCount);
                    if (reply === 1) {
                        bFlushLastPage = true;
                        console.log("last page, pageCount = " + pageCount);
                    }
                }
                else { // record added on new page
                    bFlushLastPage = true;
                }
                
                res.json(doc);
            });
        });
    
        app.delete('/records/:id', function(req, res, next){
            var id = req.params.id;
            console.log("delete " + id);
            records_collection.deleteOne({'_id': new ObjectId(id)}, async function(err, results){
                console.log(results);

                // clear cache
                console.log("DB changed, clearing cache!");
                await RedisClient.flushall();

                res.json(results);
            });
        });
    
        app.put('/records/:id', function(req, res, next){
            var id = req.params.id;
            records_collection.updateOne(
                {'_id': new ObjectId(id)},
                { $set: {
                    'name' : req.body.name,
                    'email': req.body.email,
                    'phone': req.body.phone
                    }
                }, async function(err, results){
                    console.log(results);

                    // clear cache
                    //console.log("DB changed, clearing cache!");
                    //await RedisClient.flushall();

                    // Flush cache strategy:
                    // - Notify server to bypass cache for current page
                    nPageToRefresh = nCurrentPage;

                    res.json(results);
            });
        });
    
        app.use(errorHandler);
        var server = app.listen(process.env.PORT || 3000, function() {
            var port = server.address().port;
            console.log('Express server listening on port %s.', port);
        })
    });
}

// main function
main();
