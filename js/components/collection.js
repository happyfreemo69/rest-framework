module.exports = function() {
    return new Collection();
}

var Promise = require('bluebird'),
        _ = require('lodash'),
        url = require('url');

var rfUtils = require('./utils');

Collection = function() {}

Collection.prototype.resolvePagination = function(req, count) {
    return new Promise(function(resolve, reject) {
        var page = parseInt(req.query.page);
        var limit = parseInt(req.query.limit);

        if (isNaN(page) || !_.isNumber(page)) {
            page = 1;
        }
        if (isNaN(limit) || !_.isNumber(limit)) {
            limit = 10;
        }

        var since = req.query.since != undefined ? req.query.since : null;
        var before = req.query.before != undefined ? req.query.before : null;
        var until = req.query.until != undefined ? req.query.until : null;


        limit = Math.max(limit, 1);
        var maxPage = Math.max(Math.ceil(count / limit), 1);
        page = Math.min(Math.max(page, 1), maxPage);

        var pagination = {
            offset: (page - 1) * limit,
            limit: limit,
            page: page,
            count: count,
            lastPage: Math.max(Math.ceil(count / limit), 1),
            since: since,
            before: before,
            until: until
        };
        if(req.query.now){
            pagination.now = req.query.now;
        }

        resolve(pagination);
    });
}

Collection.prototype.generateLinks = function(req, pagination) {
    var components = url.parse(req.protocol + '://' + req.get('host') + req.originalUrl, true);
    delete components.search;
    var queryObj = components.query;

    var getLink = function(page) {
        var newQueryObj = _.extend(queryObj, {page: page, limit: pagination.limit});
        return url.format(_.extend(components, {query: newQueryObj}));
    }

    var links = {};
    links.first = getLink(1);
    links.last = getLink(pagination.lastPage);
    links.current = getLink(pagination.page);

    if (pagination.page > 1) {
        links.previous = getLink(pagination.page - 1);
    }
    if (pagination.page < pagination.lastPage) {
        links.next = getLink(pagination.page + 1);
    }

    return Promise.resolve(links);
}

/*
Consider following axis
---------------------->t
0        |              now
         T

Suppose T is the current value.
The navigation is oriented like this:

next<------------>prev
that is : 
for next you return : [T-3,T-2,T-1]
for prev you return : [T+1, T+2, T+3]

for last you return : [2,1,0]
for first you return: [now, now-1, now-2]

That is you order your array: first elem is the most recent
last elem is the oldest.

until is the almost the same as previous (except for a get link which removes outer scoped variables :) )
so first, will do the same as previous?????

 */
Collection.prototype.generateTimestampLinks = function(req, items, dateExtractor, pagination) {
    var components = url.parse(req.protocol + '://' + req.get('host') + req.originalUrl, true);

    delete components.search;
    var queryObj = components.query;
    var getLink = function(name, value) {

        delete queryObj.since;
        delete queryObj.before;
        delete queryObj.until;

        var newQueryObj = _.extend(queryObj, {limit: pagination.limit});

        newQueryObj[name] = value;
        return url.format(_.extend(components, {query: newQueryObj}));
    }

    var getLink2 = function(params) {

        delete queryObj.since;
        delete queryObj.before;
        delete queryObj.until;


        var newQueryObj = _.extend(queryObj, _.extend(params, {limit: pagination.limit}));

        return url.format(_.extend(components, {query: newQueryObj}));
    }

    hasFirst = function() {
        if (items.length == 0) {
            return false;
        }

        return pagination.before || !!pagination.since;
    }


    hasLast = function() {
        return items.length != 0;
    };

    hasPrevious = function() {
        //previous code was wrong. you could not have the link
        //although you were in the past and there were futur events
        return true;
    };

    hasNext = function() {
        if (items.length == 0)
            return false;
        if (parseInt(pagination.since, 10) === 0)
            return false;
        if (items.length < pagination.limit)
            return false;
        return true;
    };

    var links = {};
    if (hasFirst()) {

        var item = _.first(items);
        var value = item[dateExtractor];

        links.first = getLink('until', value);
    }

    if (hasLast()) {

        links['last'] = getLink('since', '0');
        if (items.length != 0) {


            var item = _.last(items);
            var value = item[dateExtractor];

            links['last'] = getLink2({'since': 0, 'before': value});
        }
    }

    if (hasPrevious()) {
        if(items.length){

            var item = _.first(items);
            var value = item[dateExtractor];

            links['previous'] = getLink('since', value);
        }else{
            //fix #601 for chats. for proper stuff open a ticket
            //just always target the same timestamp
            //if a new freemo appear, we will jump to the given timestamp
            links['previous'] = getLink('since', pagination.since || pagination.before || Date.now());
        }
    }

    if (hasNext()) {

        var item = _.last(items);
        var value = item[dateExtractor];
        links['next'] = getLink('before', value);
    }

    return Promise.resolve(links);
}

/*
Works almost the same as generateTimestmapLink with the following requirement:
- Always show first
- Always show last
- Do not show next if no elements after current page
- Do not show prev if no elements before current page
 */
Collection.prototype.generateTimeClosedLinks = function(req, items, dateExtractor, pagination) {
    function itemToTs(item){
        if(typeof(dateExtractor)=='string'){
            return item[dateExtractor];
        }
        return dateExtractor(item);
    }
    var components = url.parse(req.protocol + '://' + req.get('host') + req.originalUrl, true);
/*
Here is how it works:

# handling the prev link presence
1- from the first generation of collection trigger action T:
we know it is the first generation of collection by presence of the __now__ query key

Action T:
put in every links the now value, now being the timestamp of the first element returned.

2- in case it is not a first generation, trigger action U:

Action U:
forward now value in every links

To generate a prev link, check if ts of first item is bigger or equal than now.
iff no, generates prev link
 */
    delete components.search;
    var queryObj = components.query;

    var firstItemTs = (function(arr){
        if(arr.length){
            return itemToTs(arr[0]);
        }
        return Date.now();
    })(items);

    var now = pagination.now || firstItemTs+1;//we will do a before from mongo, so keep +1 to keep the first item
    var getLink = function(params) {
        delete queryObj.since;
        delete queryObj.before;
        delete queryObj.until;
        var newQueryObj = _.extend(queryObj, params, {limit: pagination.limit, now:now});
        return url.format(_.extend(components, {query: newQueryObj}));
    }

    var has = {
        first:function(){return true;},
        last:function(){return true;},
        next:function(){
            if (items.length == 0)
                return false;
            if (pagination.since === 0)
                return false;
            if (items.length < pagination.limit)
                return false;
            return true;
        },
        previous:function(){
            //we shall NEVER have an empty collection
            //except if it is the first call and there is just no items
            //in which case, no prev is expected
            if(items.length == 0){
                return false;
            }

            //if it is the first display don't show prev
            //the first display is known from the absence of now
            if(!pagination.now){
                return false;
            }

            return firstItemTs + 1 < now;
        }
    };

    var buildLink = {
        first:function(){
            return getLink({'before':now});
        },
        last:function(){
            var where = {'since': 0};
            if (items.length != 0) {
                where.before = firstItemTs;
            }
            return getLink(where);
        },
        previous:function(){
            if(items.length){
                return  getLink({'since': firstItemTs});
            }
            //if we happen to have removed items during pagination of the collection
            //collection is in a corrupted state.
            //just try to link to the first page instead.
            //in case first element of the first page has been removed
            //happen what it may
            if(pagination.before && pagination.before < firstItemTs){
                return getLink({'since': pagination.before});
            }
            return getLink({before: firstItemTs});
        },
        next:function(){
            var item = _.last(items);
            var ts = itemToTs(item);
            return getLink({'before': ts});
        }
    }
    var links = ['first','previous','next','last'].reduce(function(acc, key){
        if(has[key]()){
            acc[key] = buildLink[key]();
        }
        return acc;
    }, {});

    return Promise.resolve(links);
}


Collection.prototype.generateFirebaseLinks = function(req, items, dateExtractor, pagination) {

    var components = url.parse(req.protocol + '://' + req.get('host') + req.originalUrl, true);
    delete components.search;
    var queryObj = components.query;

    var getLink = function(name, value) {

        delete queryObj.since;
        delete queryObj.before;

        var newQueryObj = _.extend(queryObj, {limit: pagination.limit});

        newQueryObj[name] = value;
        return url.format(_.extend(components, {query: newQueryObj}));
    }

    hasPrevious = function() {
        if (items.length == 0)
            return false;

        return pagination.before != null || pagination.since != null ? true : false;
    };

    hasNext = function() {
        if (items.length == 0)
            return false;
        if (pagination.since === 0)
            return false;
        if (items.length < pagination.limit)
            return false;
        return true;
    };

    var links = {};


    if (hasPrevious()) {

        var item = _.first(items);
        var value = item[dateExtractor];

        links['previous'] = getLink('since', value);
    }

    if (hasNext()) {

        var item = _.last(items);
        var value = item[dateExtractor];
        links['next'] = getLink('before', value);
    }

    return Promise.resolve(links);
}

/**
 * ensure data promise is a promise
 * ensure countPromise is a promier
 * ensure data promise call returns a promise
 * @return result of call of countPromise
 */
function ensureCorrectPromises(dataPromise, countPromise){
    if (typeof countPromise != "function") {
        return Promise.reject(new Error("countPromise is not a function"));
    }
    var promise = countPromise();
    if (!rfUtils.isPromise(promise)) {
        return Promise.reject(new Error("result returned by countPromise is not a Promise"));
    }
    if (typeof dataPromise != "function") {
        return Promise.reject(new Error("dataPromise is not a function"));
    }
    return promise;
}

/**
 * return a collection paginated by page/limit variables
 */
Collection.prototype.returnCollection = function(req, res, dataPromise, countPromise) {
    var self = this;

    return ensureCorrectPromises(dataPromise, countPromise).then(function(count) {
        return self.resolvePagination(req, count);
    }).then(function(pagination) {
        return Promise.props({
            count: pagination.count,
            items: dataPromise(pagination),
            links: self.generateLinks(req, pagination)
        })
    });
}

/**
 * return a closed collection paginated by timestamp with the first/most recent element fixed in time
 * @param {string or func} dataExtractor if string, it is assumes to be a property of item being a timestamp
 * if function, function has the following signature (item)->timestamp
 */
Collection.prototype.returnTimeClosedCollection = function(req, res, dataPromise, countPromise, dateExtractor) {
    var self = this;

    return ensureCorrectPromises(dataPromise, countPromise).then(function(count) {
        return self.resolvePagination(req, count);
    }).then(function(pagination) {

        return dataPromise(pagination).then(function(items) {
            return Promise.props({
                count: pagination.count,
                items: items,
                links: self.generateTimeClosedLinks(req, items, dateExtractor, pagination)
            })
        });
    });
}

/**
 * return a semi-opened collection with the first/most recent element not fixed in time
 */
Collection.prototype.returnCollectionTimestamp = function(req, res, dataPromise, countPromise, dateExtractor) {
    var self = this;

    return ensureCorrectPromises(dataPromise, countPromise).then(function(count) {
        return self.resolvePagination(req, count);
    }).then(function(pagination) {

        return dataPromise(pagination).then(function(items) {
            return Promise.props({
                count: pagination.count,
                items: items,
                links: self.generateTimestampLinks(req, items, dateExtractor, pagination)
            })
        })
    });
}



Collection.prototype.returnCollectionFirebase = function(req, res, dataPromise, countPromise, dateExtractor) {
    var self = this;

    return ensureCorrectPromises(dataPromise, countPromise).then(function(count) {
        return self.resolvePagination(req, count);
    }).then(function(pagination) {

        return dataPromise(pagination).then(function(items) {
            return Promise.props({
                count: pagination.count,
                items: items,
                links: self.generateFirebaseLinks(req, items, dateExtractor, pagination)
            })
        })
    });
}
