module.exports = function(app, security, settings, errorHandler) {
    return new Routing(app, security, settings, errorHandler);
}

var _ = require('lodash'),
        changeCase = require('change-case');
Validation = require('validator-framework'),
        rfUtils = require('./utils'),
        rfErrors = require('./error'),
        Promise = require('bluebird');

        securityFramework = require('security-framework');


var Routing = function(app, security, settings, errorHandler) {
    this.app = app;
    this.security = security;
    this.settings = _.extend({
        pathControllers: process.cwd() + '/controllers'
    }, settings);
    this.controllers = {};

    if(errorHandler == null) {
        errorHandler = rfErrors({
            debug: settings != undefined && settings.debug != undefined ? settings.debug : false
        });
    }


    defaultSecurity = securityFramework.Security({
        methods: {
            oauth: {
                config: {
                    endpoint: "http://127.0.0.1:3000/me"
                }
            },
            http: {
                config: {
                    realm: 'Evibe Private Api',
                    user: 'admin',
                    password: 'private'
                }
            }
        },
        rules: {
            guest: {
                methods: ['guest']
            },
            user: {
                methods: ['oauth', 'http']
            }
        }
    })

    this.security = defaultSecurity;

    if(security != null) {
        this.security = _.merge(this.security, security);
        this.security.registerMiddlewaresFromPath(security.pathMiddlewares);
        this.security.validate();
    }

    this.errorHandler = errorHandler;
    this.traceRouteLoaded = [];

    return this;
}

/**
 * @param  {string} name  Can be any string as long as it can be required. (dir1/dir2/module.js is ok)
 * @param  {[type]} config [description]
 * @return {[type]}        [description]
 */
Routing.prototype.loadController = function(name, config) {

    var controller = require(this.settings.pathControllers + '/' + name)(this.app, config);
    if(typeof(controller) == 'undefined'){
        throw 'expects a controller instance for '+name;
    }
    this.controllers[(name.toLowerCase())] = controller;

    return controller;
}

/**
 * @param  {string} method ex:GET/PUT/PATCH...
 * @param  {string} route ex: /v1/buildings/list
 * @param  {string} security   name of a security rule
 * @param  {string} controller ex: admin/listBuildings
 * @param  {sucks} validator 
 * @return {[type]}            [description]
 */
Routing.prototype.loadRoute = function(method, route, security, controller, validator) {
    var debug = "[+] " + method + " " + route + (validator ? " (validation)" : "");
    this.traceRouteLoaded.push(debug);
    
    if (process.argv[2] && process.argv[2] == 'debug-route') {
        console.log(debug);
    }

    var args = [route, this.security.getSecurityMiddleware(security)];
    var m;
    switch (method.toLowerCase()) {
        case 'all':
            m = this.app.all;
            break;
        case 'get':
            m = this.app.get;
            break;
        case 'post':
            m = this.app.post;
            break;
        case 'delete':
            m = this.app.delete;
            break;
        case 'patch':
            m = this.app.patch;
            break;
        case 'put':
            m = this.app.put;
            break;
        default:
            debug = "Method not allowed: " + method;
            this.traceRouteLoaded.push(debug);
            if (process.argv[2] && process.argv[2] == 'debug-route') {
                console.log(debug);
            }
            
            return;
    }

    if (_.isFunction(controller)) {
        args.push(controller);
    } else {
        var methods = this.resolveControllerValidation(controller);
        var wrapperController = new WrapperController(this.errorHandler, methods, { finalize: this.settings.finalize, validateRequest: this.settings.validateRequest} );

        if (methods.validation) {
            args.push(wrapperController.handleRequestValidation());
        }
        args.push(wrapperController.handleRequest());
    }
    m.apply(this.app, args);

    return this;
}

WrapperController = function(errorHandler, methods, settings) {
    this.methods = methods;
    this.errorHandler = errorHandler;
    this.settings = settings;

    return this;
}

WrapperController.prototype.handleRequestValidation = function() {
    var self = this;

    return function(req, res, next) {
        var handlerResult = self.methods['validation'].apply(self.methods['controller'], [req, res]);
        if (_.isObject(handlerResult)) {
            handlerResult = Promise.resolve(handlerResult);
        } else if (!rfUtils.isPromise(handlerResult)) {
            throw new Error("baby :)");
        }

        handlerResult.then(function(validations) {
            var promises = [];
            _.each(validations, function(validation) {
                var applyOn = validation.on;
                var groups = validation.groups;
                if (groups && !_.isArray(groups)) {
                    groups = [groups];
                }
                var rules = validation.rules;
                var data = req[applyOn] || {};
                //as of https://github.com/expressjs/body-parser/issues/109
                //req.body does not benefit from hasOwnProperty anymore
                //we ensure that if it was provided by the user as a string we ignore it.
                if(typeof(data.hasOwnProperty)!='function'){
                    data.hasOwnProperty = Object.hasOwnProperty.bind(data);
                }
                promises.push(self.getPromiseValidation(data, rules, groups, applyOn));
            });
            if (promises.length == 0) {
                next();
            }

            Promise.settle(promises)
                    .then(function(results) {
                        var errors = [];
                        _.each(results, function(promiseResult) {
                            if (promiseResult.isRejected()) {
                                errors.push(promiseResult.reason());
                            }

                            if(promiseResult.isFulfilled()){
                                var data = promiseResult.value();
                                if(req.validatedValues == undefined) {

                                    var ValidatedValueHelper = function() {
                                    }

                                    ValidatedValueHelper.prototype.getFieldValue = function(field, domain) {

                                        var domains = ["_params", "_body", "_query"];

                                        if(domain != undefined && !_.contains(domains, domain)) {
                                            throw new Error("invalid domain values");
                                        }
                                        
                                        if(domain != undefined) {
                                            domains = [domain]
                                        }

                                        for(var i =0; i < domains.length; i++) {
                                            var domain = domains[i];
                                            
                                            var result = _.find(this[domain], function(key) {
                                                if (key.field === field) {
                                                    return true;
                                                }
                                            });

                                            if (result) {
                                                return result.value;
                                            }
                                        }
                                    }

                                    ValidatedValueHelper.prototype.set = function (domain, values) {
                                        var self = this;

                                        switch(domain) {
                                            case 'params':
                                            case 'body':
                                            case 'query':
                                                self["_"+domain] = values;
                                                return;

                                            default:
                                                throw new Error("invalid domain values");
                                                return;
                                        }
                                    }

                                    ValidatedValueHelper.prototype.params = function (key) {
                                         return this.getFieldValue(key, "_params");
                                    }

                                    ValidatedValueHelper.prototype.query = function (key) {
                                         return this.getFieldValue(key, "_query");
                                    }

                                    ValidatedValueHelper.prototype.body = function (key) {
                                         return this.getFieldValue(key, "_body");
                                    }
                                    
                                    req.validatedValues = new ValidatedValueHelper();
                                }
                                req.validatedValues.set(data["applyOn"], data.validatedValue); 
                            }
                        });
                        if (errors.length > 0) { 
                            if (self.methods.validationErrorHandler) {
                                var handlerResult = self.methods['validationErrorHandler'].apply(self.methods['controller'], [errors, req, res]);
                                return self.errorHandler.handleError(handlerResult, req, res, next);
                            }                            
                            return self.sendValidationErrors(req, res, errors, next);
                        }
                        
                        return next();
                        
                    });
        });
    }
}

WrapperController.prototype.getPromiseValidation = function(data, rules, groups, applyOn) {
    var self = this;
    var args = arguments;

    return new Promise(function(resolve, reject) {
        return new Promise(function(res, rej){
            if(self.settings.validateRequest) {
                return self.settings.validateRequest.apply(null, args).then(res).catch(rej);
            }
            return Validation.ObjectValidator(rules).validate(data, {groups: groups}).then(res).catch(rej);
        }).then(function(result) {
            return resolve({validatedValue: result, applyOn: applyOn});
        }).catch(function(error) {
            error.applyOn = applyOn;
            return reject(error);
        });
    });
}

WrapperController.prototype.sendValidationErrors = function(req, res, errors, next) {
    return this.errorHandler.handleError(new handler.prototype.ValidationParametersError(errors), req, res, next);
}

WrapperController.prototype.handleRequest = function() {

    var self = this;

    return function(req, res, next) {

        try {
            var handler = self.methods['action'].apply(self.methods['controller'], [req, res]);

            if (rfUtils.isPromise(handler)) {

                handler.then(function(jsonResult) {
                    
                    if(self.settings.finalize){
                        return self.settings.finalize(req, res, next, jsonResult);
                    }

                    if (typeof jsonResult == "object") {
                        res.status(200).json(jsonResult);
                        next();
                    } else if (typeof jsonResult == "string") {
                        res.status(200).json(jsonResult);
                        next();
                    }
                    else if (typeof jsonResult == "function") {
                        return jsonResult(req, res, next);
                    } else {
                        var e = new Error("INTERNAL_ERROR");
                        e.details = 'your promise must return an function(req, res) or object/string';
                        throw e;
                    }

                }).catch(function(e) {
                    // promise failed
                    return self.errorHandler.handleError(e, req, res, next);
                });

            } else {

                if(self.settings.finalize){
                    return self.settings.finalize(req, res, next, handler);
                }

                if (typeof handler == "object") {
                    res.status(200).json(handler);
                    next()
                } else if (typeof handler == "function") {
                    handler(req, res, next);
                    next()
                } else if (typeof handler == "string") {
                    res.json(handler);
                    next()
                } else {
                    var e = new Error("INTERNAL_ERROR");
                    throw e;
                }
            }

        } catch (e) {
            // catch for non promise return
            return self.errorHandler.handleError(e, req, res, next);
        }
    }
};

/**
 * @param  {string} controllerName ex: /v1/buildings/list
 * @return {[type]}       [description]
 */
Routing.prototype.resolveControllerValidation = function(controller) {
    var parts = controller.split('/');
    if (parts.length < 2) {
        throw new Error("Error resolving " + controller);
        return;
    }

    var controllerId = parts.slice(0,-1).join('/').toLowerCase();
    var action = parts.slice(-1)[0];
    var methodAction = 'get' + changeCase.upperCaseFirst(action) + 'Action';
    var methodValidation = 'get' + changeCase.upperCaseFirst(action) + 'Validation';
    var methodValidationErrorHandler = 'get' + changeCase.upperCaseFirst(action) + 'ValidationErrorHandler';
    var validation = undefined;
    var validationErrorHandler = undefined;

    if (!_.has(this.controllers, controllerId)) {
        throw new Error("Controller not found : " + controllerId);
    }

    if (!_.isFunction(this.controllers[controllerId][methodAction])) {
        throw new Error("Method not found : " + methodAction + " on controller " + controllerId);
    }

    if (_.isFunction(this.controllers[controllerId][methodValidation])) {
        validation = this.controllers[controllerId][methodValidation];
    }

    if (_.isFunction(this.controllers[controllerId][methodValidationErrorHandler])) {
        validationErrorHandler = this.controllers[controllerId][methodValidationErrorHandler];
    }

    return {controller: this.controllers[controllerId], action: this.controllers[controllerId][methodAction], validation: validation, validationErrorHandler: validationErrorHandler};
}
