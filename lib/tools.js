/* eslint no-bitwise: 0 */

'use strict';

const msgpack = require('msgpack5')();
const enumMessageFlags = require('./enum-message-flags');
const Joi = require('joi');
const fetch = require('node-fetch');
const he = require('he');
const packageData = require('../package.json');
const settings = require('./settings');

module.exports = {
    /**
     * Helper function to set specific bit in a buffer
     * @param {Buffer} buffer Buffer to edit
     * @param {Number} bytePos Which byte in buffer to edit
     * @param {Number} bit Which bit to update
     * @param {Boolean} value If true, then sets bit, if false, then clears it
     * @returns {Boolean} If true then bit was updated
     */
    setBit(buffer, bytePos, bit, value) {
        bytePos = Number(bytePos) || 0;
        if (bytePos < 0 || bytePos >= buffer.length) {
            return false;
        }

        if (!value) {
            buffer[bytePos] &= ~(1 << bit);
        } else {
            buffer[bytePos] |= 1 << bit;
        }

        return true;
    },

    /**
     * Helper function to get specific bit from a buffer
     * @param {Buffer} buffer Buffer to check for
     * @param {Number} bytePos Which byte in buffer to check
     * @param {Number} bit Which bit to check
     * @returns {Boolean} If true then bit was set, otherwise bit was not set
     */
    readBit(buffer, bytePos, bit) {
        return !!((buffer[bytePos] >> bit) % 2);
    },

    /**
     * Parses stored message entry
     * @param {Buffer} buffer Stored message entry
     * @ @returns {Object} Message entry object
     */
    unserialize(buffer) {
        // < [4B (UInt32LE) UID] [1B ENUM_FLAGS] [8B (BigUInt64LE) MODSEQ] [nB META (msgpack) [msgid, [flags], [labels]] ] >

        if (buffer.length === 1) {
            switch (buffer.toString()) {
                case 'D': {
                    return { deleted: true };
                }
                case 'N': {
                    return { placeholder: true };
                }
            }
            return {};
        }

        let uid = buffer.readUInt32LE(0);
        let modseq = buffer.readBigUInt64LE(5);

        let formatted = {
            uid,
            flags: new Set()
        };

        if (modseq) {
            formatted.modseq = modseq;
        }

        enumMessageFlags.forEach((flag, i) => {
            if (module.exports.readBit(buffer, 4, i)) {
                formatted.flags.add(flag);
            }
        });

        if (buffer.length > 4 + 1 + 8) {
            let extra = msgpack.decode(buffer.slice(4 + 1 + 8));
            if (Array.isArray(extra)) {
                let emailId = extra[0];
                if (emailId) {
                    formatted.emailId = emailId;
                }

                if (Array.isArray(extra[1])) {
                    extra[1].forEach(flag => {
                        formatted.flags.add(flag);
                    });
                }

                if (Array.isArray(extra[2])) {
                    formatted.labels = new Set(extra[2]);
                }
            }
        }

        return formatted;
    },

    /**
     * Generates message entry for storage
     * @param {Object} messageData Message entry object
     * @ @returns {Buffer} Serialized message entry for storage
     */
    serialize(messageData) {
        let buf = Buffer.alloc(4 + 1 + 8);
        buf.writeUInt32LE(messageData.uid, 0);

        let extra = [
            messageData.emailId || null, //emailId (if exists)
            null, // extra flags not in the default flag set
            null // labels if Gmail All data
        ];

        for (let flag of messageData.flags) {
            let enumFlag = enumMessageFlags.indexOf(flag);
            if (enumFlag >= 0) {
                module.exports.setBit(buf, 4, enumFlag, true);
            } else {
                if (!extra[1]) {
                    extra[1] = [];
                }
                extra[1].push(flag);
            }
        }

        if (messageData.labels && messageData.labels.size) {
            extra[2] = Array.from(messageData.labels);
        }

        if (messageData.modseq) {
            buf.writeBigUInt64LE(messageData.modseq, 5);
        }

        return Buffer.concat([buf, msgpack.encode(extra)]);
    },

    /**
     * Compares two message objects to see if there are any changes
     * @param {*} storedMessageEntry
     * @param {*} messageData
     * @returns {Object | Boolean} Changes or false
     */
    compareExisting(storedMessageEntry, messageData, keys) {
        const changes = {};
        let hasChanges = false;

        // detect deleted flags
        if (!keys || keys.includes('flags')) {
            for (let flag of storedMessageEntry.flags.values()) {
                if (!messageData.flags.has(flag)) {
                    if (!changes.flags) {
                        changes.flags = {};
                    }
                    if (!changes.flags.deleted) {
                        changes.flags.deleted = [];
                    }
                    changes.flags.deleted.push(flag);
                    hasChanges = true;
                }
            }

            // detect added flags
            for (let flag of messageData.flags.values()) {
                if (!storedMessageEntry.flags.has(flag)) {
                    if (!changes.flags) {
                        changes.flags = {};
                    }
                    if (!changes.flags.added) {
                        changes.flags.added = [];
                    }
                    changes.flags.added.push(flag);
                    hasChanges = true;
                }
            }
        }

        if (!keys || keys.includes('labels')) {
            if (storedMessageEntry.labels || messageData.labels) {
                if (storedMessageEntry.labels) {
                    // detect deleted labels
                    for (let flag of storedMessageEntry.labels.values()) {
                        if (!messageData.labels || !messageData.labels.has(flag)) {
                            if (!changes.labels) {
                                changes.labels = {};
                            }
                            if (!changes.labels.deleted) {
                                changes.labels.deleted = [];
                            }
                            changes.labels.deleted.push(flag);
                            hasChanges = true;
                        }
                    }
                }
                if (messageData.labels) {
                    // detect added labels
                    for (let flag of messageData.labels.values()) {
                        if (!storedMessageEntry.labels || !storedMessageEntry.labels.has(flag)) {
                            if (!changes.labels) {
                                changes.labels = {};
                            }
                            if (!changes.labels.added) {
                                changes.labels.added = [];
                            }
                            changes.labels.added.push(flag);
                            hasChanges = true;
                        }
                    }
                }
            }
        }

        return hasChanges ? changes : false;
    },

    normalizePath(path) {
        if (/^INBOX$/i.test(path)) {
            return 'INBOX';
        }
        return path;
    },

    async resolveCredentials(account, proto) {
        let authServer = await settings.get('authServer');
        if (!authServer) {
            let err = new Error('Authentication server requested but not set');
            throw err;
        }

        let headers = { 'User-Agent': `${packageData.name}/${packageData.version} (+https://emailengine.app)` };

        let parsed = new URL(authServer);
        let username, password;

        if (parsed.username) {
            username = he.decode(parsed.username);
            parsed.username = '';
        }

        if (parsed.password) {
            password = he.decode(parsed.password);
            parsed.password = '';
        }

        if (username || password) {
            headers.Authorization = `Basic ${Buffer.from(he.encode(username || '') + ':' + he.encode(password || '')).toString('base64')}`;
        }

        parsed.searchParams.set('account', account);
        parsed.searchParams.set('proto', proto);

        let authResponse = await fetch(parsed.toString(), { method: 'GET', headers });
        if (!authResponse.ok) {
            throw new Error(`Invalid response: ${authResponse.status} ${authResponse.statusText}`);
        }

        let authData = await authResponse.json();
        if (!authData) {
            throw new Error('Failed resolving credentials for ' + account);
        }

        const schema = Joi.object({
            user: Joi.string().max(256).required(),
            pass: Joi.string().allow('').max(256),
            accessToken: Joi.string().max(4096)
        }).xor('pass', 'accessToken');

        const { error, value } = schema.validate(authData, {
            abortEarly: false,
            stripUnknown: true,
            convert: true
        });

        if (error) {
            throw error;
        }

        return value;
    },

    getDuration(val) {
        val = (val || '').toString().replace(/^([\d.]+)\s*([smhdy][a-z]*)$/i, (o, num, m) => {
            if (!num || isNaN(num)) {
                return false;
            }

            num = Number(num);
            if (!num) {
                return num;
            }

            switch (m.charAt(0).toLowerCase()) {
                case 's':
                    num = num * 1000;
                    break;
                case 'm':
                    if (/^mo/i.test(m)) {
                        // month
                        num = num * (30 * 24 * 3600 * 1000);
                    } else {
                        // minute
                        num = num * (60 * 1000);
                    }
                    break;
                case 'h':
                    num = num * (3600 * 1000);
                    break;
                case 'd':
                    num = num * (24 * 3600 * 1000);
                    break;
                case 'y':
                    num = num * (365 * 24 * 3600 * 1000);
                    break;
            }

            return Math.round(num);
        });

        if (isNaN(val)) {
            return val;
        }

        return Number(val);
    },

    getByteSize(val) {
        val = (val || '').toString().replace(/^([\d.]+)\s*([kMGTP])B?$/i, (o, num, m) => {
            if (!num || isNaN(num)) {
                return false;
            }

            num = Number(num);
            if (!num) {
                return num;
            }

            switch (m.toUpperCase()) {
                case 'K':
                    num = num * 1024;
                    break;
                case 'M':
                    num = num * 1024 * 1024;
                    break;
                case 'G':
                    num = num * 1024 * 1024 * 1024;
                    break;
                case 'T':
                    num = num * 1024 * 1024 * 1024 * 1024;
                    break;
                case 'P':
                    num = num * 1024 * 1024 * 1024 * 1024 * 1024;
                    break;
            }

            return Math.round(num);
        });

        if (isNaN(val)) {
            return val;
        }

        return Number(val);
    },

    formatAccountListingResponse(entry) {
        if (Array.isArray(entry)) {
            let obj = {};
            for (let i = 0; i < entry.length; i += 2) {
                obj[entry[i]] = entry[i + 1];
            }
            return obj;
        }
        // return default
        return entry;
    },

    async getCounterValues(redis, seconds) {
        seconds = Number(seconds) || 3600;

        let now = new Date();
        let startTime = new Date(now.getTime() - seconds * 1000);

        let hashKeys = [];

        // find out all the date buckets we need to check for
        let endDateStr = `${now
            .toISOString()
            .substr(0, 10)
            .replace(/[^0-9]+/g, '')}`;
        let dateStr = '00000000';
        let hashTime = startTime;

        let startTimeStr = `${startTime
            .toISOString()
            // bucket includes 1 minute
            .substr(0, 16)
            .replace(/[^0-9]+/g, '')}`;

        while (dateStr < endDateStr) {
            dateStr = `${hashTime
                .toISOString()
                .substr(0, 10)
                .replace(/[^0-9]+/g, '')}`;
            hashKeys.push(dateStr);
            hashTime = new Date(hashTime.getTime() + 24 * 3600 * 1000);
        }

        // list potential counter keys
        let statUpdateKeys = await redis.smembers('stats:keys');

        let req = redis.multi();
        let rIndex = [];

        for (let statUpdateKey of statUpdateKeys) {
            // load stats for this key
            for (let dateStr of hashKeys) {
                req = req.hgetall(`stats:${statUpdateKey}:${dateStr}`);
                rIndex.push(statUpdateKey);
            }
        }

        let res = await req.exec();

        let counters = {};

        for (let i = 0; i < res.length; i++) {
            let value = res[i];
            let statUpdateKey = rIndex[i];

            if (value[0]) {
                // error found
            } else {
                Object.keys(value[1] || {}).forEach(key => {
                    if (key >= startTimeStr) {
                        if (!counters[statUpdateKey]) {
                            counters[statUpdateKey] = 0;
                        }
                        counters[statUpdateKey] += Number(value[1][key]) || 0;
                    }
                });
            }
        }

        return counters;
    },

    getAuthSettings(authStr) {
        if (!authStr || typeof authStr !== 'string') {
            return { enabled: false };
        }
        let sep = authStr.indexOf(':');
        let user = authStr.substr(0, sep).trim();
        let pass = authStr.substr(sep + 1);
        if (!user || !pass) {
            return { enabled: false };
        }
        return { enabled: true, user, pass };
    },

    escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
    }
};
