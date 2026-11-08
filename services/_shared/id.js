'use strict';

const crypto = require('node:crypto');

function uuid() {
  return crypto.randomUUID();
}

function generateId(prefix = '') {
  const hex = crypto.randomBytes(8).toString('hex');
  return prefix ? `${prefix}_${hex}` : hex;
}

function correlationId() {
  return `corr_${crypto.randomBytes(8).toString('hex')}`;
}

function eventId() {
  return `evt_${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = {
  uuid,
  generateId,
  correlationId,
  eventId,
};
