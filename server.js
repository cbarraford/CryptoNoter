/**
 * CryptoNoter v1.2
 * In-Browser Javascript XMR miner for websites / Payout towards personal XMR wallet
 * Built for in-browser javascript mining on any Monero pools. 0% Commission. 100% Payout
 */
var http = require('http'),
    https = require('https'),
    WebSocket = require("ws"),
    net = require('net'),
    fs = require('fs'),
    crypto = require("crypto");
    redis = require("redis");
    dateFormat = require('dateformat');


var banner = fs.readFileSync(__dirname + '/banner', 'utf8');

var conf = {};
// check if config file exists
if (fs.existsSync(__dirname + '/config.json')) {
  var conf = fs.readFileSync(__dirname + '/config.json', 'utf8');
  conf = JSON.parse(conf);
}

//heroku port
conf.lport = process.env.PORT || conf.lport;
conf.domain = process.env.DOMAIN || conf.domain;
conf.key = process.env.KEY || conf.key;
conf.cert = process.env.CERT || conf.cert;
conf.pool = process.env.POOL || conf.pool;
conf.addr = process.env.ADDR || conf.addr;
conf.pass = process.env.PASS || conf.pass;
conf.redis_url = process.env.REDIS_URL || conf.redis_url;

if (!conf.lport) {
  console.error("Port (lport) needs to be defined in the config or via environment variable (PORT)");
  process.exit(1);
};

if (!conf.domain) {
  console.error("Domain (domain) needs to be defined in the config or via environment variable (DOMAIN)");
  process.exit(1);
}

if (!conf.pool) {
  console.error("Pool (pool) needs to be defined in the config or via environment variable (POOL)");
  process.exit(1);
}

if (!conf.addr) {
  console.error("Wallet Address (addr) needs to be defined in the config or via environment variable (ADDR)");
  process.exit(1);
}

//ssl support
const ssl = !!(conf.key && conf.cert);

const redisClient = redis.createClient(conf.redis_url);

redisClient.on("error", function (err) {
    console.log("Redis Error:", err);
});

const stats = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    req.url = (req.url === '/') ? '/index.html' : req.url;
    fs.readFile(__dirname + '/web' + req.url, (err, buf) => {
        if (err) {
            fs.readFile(__dirname + '/web/404.html', (err, buf) => {
                res.end(buf);
            });
        } else {
            if (!req.url.match(/\.wasm$/) && !req.url.match(/\.mem$/)) {
                buf = buf.toString().replace(/%CryptoNoter_domain%/g, conf.domain);
                if (req.url.match(/\.js$/)) {
                    res.setHeader('content-type', 'application/javascript');
                }
            } else {
                res.setHeader('Content-Type', 'application/octet-stream');
            }
            res.end(buf);
        }
    });
}

//ssl support
if (ssl) {
    var web = https.createServer({
        key: fs.readFileSync(conf.key),
        cert: fs.readFileSync(conf.cert)
    }, stats)
} else {
    var web = http.createServer(stats);
}

// Miner Proxy Srv
var srv = new WebSocket.Server({
    server: web,
    path: "/proxy",
    maxPayload: 256
});
srv.on('connection', (ws) => {
    var conn = {
        uid: null,
        pid: crypto.randomBytes(12).toString("hex"),
        workerId: null,
        found: 0,
        accepted: 0,
        ws: ws,
        pl: new net.Socket(),
    }
    var pool = conf.pool.split(':');
    conn.pl.connect(pool[1], pool[0]);

    // Trans WebSocket to PoolSocket
    function ws2pool(data) {
        var buf;
        data = JSON.parse(data);
        switch (data.type) {
            case 'auth':
                {
                    conn.uid = data.params.site_key;
                    if (data.params.user) {
                        conn.uid += '@' + data.params.user;
                        conn.user_id = data.params.user;
                    }
                    buf = {
                        "method": "login",
                        "params": {
                            "login": conf.addr,
                            "pass": conf.pass,
                            "agent": "CryptoNoter"
                        },
                        "id": conn.pid
                    }
                    buf = JSON.stringify(buf) + '\n';
                    conn.pl.write(buf);
                    break;
                }
            case 'submit':
                {
                    conn.found++;
                    buf = {
                        "method": "submit",
                        "params": {
                            "id": conn.workerId,
                            "job_id": data.params.job_id,
                            "nonce": data.params.nonce,
                            "result": data.params.result
                        },
                        "id": conn.pid
                    }
                    buf = JSON.stringify(buf) + '\n';
                    conn.pl.write(buf);
                    redisClient.zincrby("shares", 1, (conn.uid || "1@1"));
                    var now = Date.now()
                    var day = dateFormat(now, "yyyy-mm-dd");
                    var hour = dateFormat(now, "yyyy-mm-dd H");
                    redisClient.zincrby(day, 1, (conn.user_id || "0"));
                    redisClient.zincrby(hour, 1, (conn.user_id || "0"));
                    //redisClient.quit();
                    break;
                }
        }
    }

    // Trans PoolSocket to WebSocket
    function pool2ws(data) {
        try {
            var buf;
            data = JSON.parse(data);
            if (data.id === conn.pid && data.result) {
                if (data.result.id) {
                    conn.workerId = data.result.id;
                    buf = {
                        "type": "authed",
                        "params": {
                            "token": "",
                            "hashes": conn.accepted
                        }
                    }
                    buf = JSON.stringify(buf);
                    conn.ws.send(buf);
                    buf = {
                        "type": "job",
                        "params": data.result.job
                    }
                    buf = JSON.stringify(buf);
                    conn.ws.send(buf);
                } else if (data.result.status === 'OK') {
                    conn.accepted++;
                    buf = {
                        "type": "hash_accepted",
                        "params": {
                            "hashes": conn.accepted
                        }
                    }
                    buf = JSON.stringify(buf);
                    conn.ws.send(buf);
                }
            }
            if (data.id === conn.pid && data.error) {
                if (data.error.code === -1) {
                    buf = {
                        "type": "banned",
                        "params": {
                            "banned": conn.pid
                        }
                    }
                } else {
                    buf = {
                        "type": "error",
                        "params": {
                            "error": data.error.message
                        }
                    }
                }
                buf = JSON.stringify(buf);
                conn.ws.send(buf);
            }
            if (data.method === 'job') {
                buf = {
                    "type": 'job',
                    "params": data.params
                }
                buf = JSON.stringify(buf);
                conn.ws.send(buf);
            }
        } catch (error) { console.warn('[!] Error: '+error.message) }
    }
    conn.ws.on('message', (data) => {
        ws2pool(data);
        console.log('[>] Request: ' + conn.uid + '\n\n' + data + '\n');
    });
    conn.ws.on('error', (data) => {
        console.log('[!] ' + conn.uid + ' WebSocket ' + data + '\n');
        conn.pl.destroy();
    });
    conn.ws.on('close', () => {
        console.log('[!] ' + conn.uid + ' offline.\n');
        conn.pl.destroy();
    });
    conn.pl.on('data', function(data) {
        var linesdata = data;
        var lines = String(linesdata).split("\n");
        if (lines[1].length > 0) {
            console.log('[<] Response: ' + conn.pid + '\n\n' + lines[0] + '\n');
            console.log('[<] Response: ' + conn.pid + '\n\n' + lines[1] + '\n')
            pool2ws(lines[0]);
            pool2ws(lines[1]);
        } else {
            console.log('[<] Response: ' + conn.pid + '\n\n' + data + '\n');
            pool2ws(data);
        }
    });
    conn.pl.on('error', (data) => {
        console.log('PoolSocket ' + data + '\n');
        if (conn.ws.readyState !== 3) {
            conn.ws.close();
        }
    });
    conn.pl.on('close', () => {
        console.log('PoolSocket Closed.\n');
        if (conn.ws.readyState !== 3) {
            conn.ws.close();
        }
    });
});
web.listen(conf.lport, () => {
    console.log(banner);
    console.log(' Listen on : ' + conf.lhost + ':' + conf.lport + '\n Pool Host : ' + conf.pool + '\n Ur Wallet : ' + conf.addr + '\n');
    console.log('----------------------------------------------------------------------------------------\n');
});
