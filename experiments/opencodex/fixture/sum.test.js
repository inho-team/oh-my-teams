/** Fixed acceptance test for the subscription comparison fixture. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sum = require('./sum.js');
test('sum adds positive and negative numbers', () => {
  assert.equal(sum(2, 3), 5);
  assert.equal(sum(-2, 3), 1);
});
