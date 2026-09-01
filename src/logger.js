'use strict';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const levelVal = LOG_LEVELS[currentLevel] ?? LOG_LEVELS.info;

function fmt(level, args) {
  const ts = new Date().toISOString();
  return [`[${ts}] [${level.toUpperCase()}]`, ...args];
}

const logger = {
  debug(...args) { if (levelVal <= 0) console.log(...fmt('debug', args)); },
  info(...args)  { if (levelVal <= 1) console.log(...fmt('info', args)); },
  warn(...args)  { if (levelVal <= 2) console.warn(...fmt('warn', args)); },
  error(...args) { if (levelVal <= 3) console.error(...fmt('error', args)); },
  child(prefix) {
    return {
      debug: (...a) => logger.debug(`[${prefix}]`, ...a),
      info:  (...a) => logger.info(`[${prefix}]`, ...a),
      warn:  (...a) => logger.warn(`[${prefix}]`, ...a),
      error: (...a) => logger.error(`[${prefix}]`, ...a),
    };
  },
};

module.exports = logger;
