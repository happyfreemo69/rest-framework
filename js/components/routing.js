module.exports = function(app, security, settings, errorHandler) {
    return new Routing(app, security, settings, errorHandler);
}

var _          = require('lodash'),
    changeCase = require('change-case');
    Validation = require('validator-framework'),
    Promise    = require('bluebird');


var Routing = function(app, security, settings, errorHandler) {
    this.app          = app;
    this.security     = security;
    this.settings     = _.extend({
        pathControllers: './controllers'
    }, settings);
    this.controllers  = {};

    this.errorHandler = errorHandler;

    return this;
}

Routing.prototype.loadController = function(name, config) {

    var controller = require(process.cwd() + '/'+ this.settings.pathControllers + '/' + name)(this.app, config);
    this.controllers[(name.toLowerCase())] = controller;

    return controller;
}


Routing.prototype.loadRoute = function(method, route, security, controller, validator) {
    console.log("[+] " + method + " " + route + (validator ? " (validation)" : ""));

    var args = [route, this.security.getSecurityMiddleware(security)];
    var m;
    switch(method.toLowerCase()) {
        case 'all':     m = this.app.all;    break;
        case 'get':     m = this.app.get;    break;
        case 'post':    m = this.app.post;   break;
        case 'delete':  m = this.app.delete; break;
        case 'patch':   m = this.app.patch;  break;
        default:        console.log("Method not allowed: "+method); return;
    }

    if (_.isFunction(controller)) {
        args.push(controller);
    } else {
        var methods           = this.resolveControllerValidation(controller);
        var wrapperController = new WrapperController(this.errorHandler, methods);

        if (methods.validation) {
            args.push(wrapperController.handleRequestValidation());
        }
        args.push(wrapperController.handleRequest());
    }
    m.apply(this.app, args);

    return this;
}

WrapperController = function (errorHandler, methods) {
   this.methods      = methods;
   this.errorHandler = errorHandler;

   return this;
}

WrapperController.prototype.handleRequestValidation = function() {
    var self = this;

    return function(req, res, next) {
        var handlerResult = self.methods['validation'].apply(self.methods['controller'], [req, res]);
        if (_.isObject(handlerResult)) {
            handlerResult = Promise.resolve(handlerResult);
        } else if (!isPromise(handlerResult)) {
            throw new Error("baby :)");
        }

        handlerResult.then(function(validations) {
            var promises = [];
            _.each(validations, function(validation) {
                var applyOn = validation.on;
                var groups   = validation.groups;
                if (groups && !_.isArray(groups)) {
                    groups = [groups];
                }
                var rules = validation.rules;
                promises.push(self.getPromiseValidation(req[applyOn] || {}, rules, groups));
            });
            if (promises.length == 0) {
                next();
            }

            Promise.settle(promises)
                   .then(function(results) {
                        console.log(results);
                        var errors    = [];
                        _.each(results, function(promiseResult) {
                            console.log(promiseResult);
                            if (promiseResult.isRejected()) {
                                errors.push(promiseResult.reason());
                            }
                        });
                        console.log(errors);
                        if (errors.length > 0) {
                            return self.sendValidationErrors(req, res, errors, next);
                        } else {
                            next();
                        }
                   });
        });
    }
}

WrapperController.prototype.getPromiseValidation = function(data, rules, groups) {
    console.log(data);
    console.log(rules);
    console.log(groups);
    return Validation.ObjectValidator(rules)
                     .validate(data, {groups: groups});
}

WrapperController.prototype.sendValidationErrors = function(req, res, errors, next) {
    return this.errorHandler.handleError(new handler.prototype.ValidationParametersError(errors), req, res, next);
}

WrapperController.prototype.handleRequest = function() {

    var self = this;
    return function(req, res, next) {

        try {
            var handler = self.methods['action'].apply(self.methods['controller'], [req, res]);

            if (isPromise(handler)) {

                handler.then(function(jsonResult) {
                    res.json(jsonResult);
                }).catch(function(e) {
                    // promise failed
                    return self.errorHandler.handleError(e, req, res, next);
                });

            } else if (typeof handler == "object") {
                res.json(handler);
            } else if(typeof handler == "function") {
                return handler(req, res);
            } else {
                var e = new Error("INTERNAL_ERROR");
                throw e;
            }

        } catch (e) {
            // catch for non promise return
            return self.errorHandler.handleError(e, req, res, next);
        }
    }
};

function isPromise(obj) {
    return (typeof obj == "object") && (typeof obj.then == "function") && obj.constructor && (obj.constructor.name == 'Promise');
}


Routing.prototype.resolveControllerValidation = function(controllerName) {
    var parts      = controllerName.split('/');
    if (parts.length != 2) {
        throw new Error("Error resolving " + controllerName);
        return;
    }

    var controller       = parts[0].toLowerCase();
    var action           = parts[1];
    var methodAction     = 'get' + changeCase.upperCaseFirst(action)+ 'Action';
    var methodValidation = 'get' + changeCase.upperCaseFirst(action)+ 'Validation';
    var validation       = undefined;

    if (!_.has(this.controllers, controller)) {
        throw new Error("Controller not found : " + controller);
    }

    if (!_.isFunction(this.controllers[controller][methodAction])) {
        throw new Error("Method not found : " + methodAction + " on controller "+controller);
    }

    if (_.isFunction(this.controllers[controller][methodValidation])) {
        validation = this.controllers[controller][methodValidation];
    }

    return {controller: this.controllers[controller], action: this.controllers[controller][methodAction], validation: validation};
}
