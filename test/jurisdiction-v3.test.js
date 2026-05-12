const assert = require('node:assert/strict');
const test = require('node:test');
const jurisdiction = require('../lib/jurisdiction');

test('v3 tracker aliases resolve to companies and countries', () => {
  for (const name of ['AdTiming', 'BidMachine', 'Dynatrace', 'Rollbar', 'Tappx', 'UXCam', 'mParticle']) {
    const resolved = jurisdiction.resolveTrackerName(name);
    assert.ok(resolved, `${name} should resolve`);
    assert.ok(jurisdiction.getUltimateParent(resolved), `${name} should have a company`);
    assert.ok(jurisdiction.getUltimateCountry(resolved), `${name} should have a country`);
  }
});
