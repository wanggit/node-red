/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

var ws = require("ws");

var log = require("../../util").log; // TODO: separate module
var Tokens;
var Users;
var Permissions;

var server;
var settings;
var runtimeAPI;

var wsServer;
var activeConnections = [];

var retained = {};

var heartbeatTimer;
var lastSentTime;

function init(_server,_settings,_runtimeAPI) {
    server = _server;
    settings = _settings;
    runtimeAPI = _runtimeAPI;
    Tokens = require("../auth/tokens");
    Users = require("../auth/users");
    Permissions = require("../auth/permissions");

}

function generateSession(length) {
    var c = "ABCDEFGHIJKLMNOPQRSTUZWXYZabcdefghijklmnopqrstuvwxyz1234567890";
    var token = [];
    for (var i=0;i<length;i++) {
        token.push(c[Math.floor(Math.random()*c.length)]);
    }
    return token.join("");
}

function CommsConnection(ws) {
    this.session = generateSession(32);
    this.ws = ws;
    this.stack = [];
    this.user = null;
    this.lastSentTime = 0;
    var self = this;

    log.audit({event: "comms.open"});
    log.trace("comms.open "+self.session);
    var pendingAuth = (settings.adminAuth != null);

    if (!pendingAuth) {
        addActiveConnection(self);
    }
    ws.on('close',function() {
        log.audit({event: "comms.close",user:self.user, session: self.session});
        log.trace("comms.close "+self.session);
        removeActiveConnection(self);
    });
    ws.on('message', function(data,flags) {
        var msg = null;
        try {
            msg = JSON.parse(data);
        } catch(err) {
            log.trace("comms received malformed message : "+err.toString());
            return;
        }
        if (!pendingAuth) {
            if (msg.subscribe) {
                self.subscribe(msg.subscribe);
                // handleRemoteSubscription(ws,msg.subscribe);
            }
        } else {
            var completeConnection = function(userScope,sendAck) {
                try {
                    if (!userScope || !Permissions.hasPermission(userScope,"status.read")) {
                        ws.send(JSON.stringify({auth:"fail"}));
                        ws.close();
                    } else {
                        pendingAuth = false;
                        addActiveConnection(self);
                        if (sendAck) {
                            ws.send(JSON.stringify({auth:"ok"}));
                        }
                    }
                } catch(err) {
                    console.log(err.stack);
                    // Just in case the socket closes before we attempt
                    // to send anything.
                }
            }
            if (msg.auth) {
                Tokens.get(msg.auth).then(function(client) {
                    if (client) {
                        Users.get(client.user).then(function(user) {
                            if (user) {
                                self.user = user;
                                log.audit({event: "comms.auth",user:self.user});
                                completeConnection(client.scope,true);
                            } else {
                                log.audit({event: "comms.auth.fail"});
                                completeConnection(null,false);
                            }
                        });
                    } else {
                        log.audit({event: "comms.auth.fail"});
                        completeConnection(null,false);
                    }
                });
            } else {
                if (anonymousUser) {
                    log.audit({event: "comms.auth",user:anonymousUser});
                    self.user = anonymousUser;
                    completeConnection(anonymousUser.permissions,false);
                    //TODO: duplicated code - pull non-auth message handling out
                    if (msg.subscribe) {
                        self.subscribe(msg.subscribe);
                    }
                } else {
                    log.audit({event: "comms.auth.fail"});
                    completeConnection(null,false);
                }
            }
        }
    });
    ws.on('error', function(err) {
        log.warn(log._("comms.error",{message:err.toString()}));
    });
}

CommsConnection.prototype.send = function(topic,data) {
    var self = this;
    if (topic && data) {
        this.stack.push({topic:topic,data:data});
    }
    if (!this._xmitTimer) {
        this._xmitTimer = setTimeout(function() {
            try {
                self.ws.send(JSON.stringify(self.stack));
                self.lastSentTime = Date.now();
            } catch(err) {
                removeActiveConnection(self);
                log.warn(log._("comms.error-send",{message:err.toString()}));
            }
            delete self._xmitTimer;
            self.stack = [];
        },50);
    }
}

CommsConnection.prototype.subscribe = function(topic) {
    runtimeAPI.comms.subscribe({
        user: this.user,
        client: this,
        topic: topic
    })
}

function start() {
    if (!settings.disableEditor) {
        Users.default().then(function(anonymousUser) {
            var webSocketKeepAliveTime = settings.webSocketKeepAliveTime || 15000;
            var path = settings.httpAdminRoot || "/";
            path = (path.slice(0,1) != "/" ? "/":"") + path + (path.slice(-1) == "/" ? "":"/") + "comms";
            wsServer = new ws.Server({
                server:server,
                path:path,
                // Disable the deflate option due to this issue
                //  https://github.com/websockets/ws/pull/632
                // that is fixed in the 1.x release of the ws module
                // that we cannot currently pickup as it drops node 0.10 support
                //perMessageDeflate: false
            });

            wsServer.on('connection',function(ws) {
                var commsConnection = new CommsConnection(ws);
            });


            wsServer.on('error', function(err) {
                log.warn(log._("comms.error-server",{message:err.toString()}));
            });

            lastSentTime = Date.now();

            heartbeatTimer = setInterval(function() {
                var now = Date.now();
                if (now-lastSentTime > webSocketKeepAliveTime) {
                    activeConnections.forEach(connection => connection.send("hb",lastSentTime));
                }
            }, webSocketKeepAliveTime);
        });
    }
}

function stop() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (wsServer) {
        wsServer.close();
        wsServer = null;
    }
}

function addActiveConnection(connection) {
    activeConnections.push(connection);
    runtimeAPI.comms.addConnection({client: connection});
}
function removeActiveConnection(connection) {
    for (var i=0;i<activeConnections.length;i++) {
        if (activeConnections[i] === connection) {
            activeConnections.splice(i,1);
            runtimeAPI.comms.removeConnection({client:connection})
            break;
        }
    }
}

module.exports = {
    init:init,
    start:start,
    stop:stop
}
