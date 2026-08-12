const assert = require('node:assert/strict');
const test = require('node:test');
const updater = require('../scripts/update-exodus-trackers');

function payload(trackers) {
  return JSON.stringify({ trackers });
}

test('keeps only the fields the report views read', () => {
  const data = updater.normalise(payload(sample({
    1: {
      id: 1,
      name: 'Teemo',
      categories: ['Location', 'Analytics'],
      description: 'a very long description',
      code_signature: 'com.teemo',
      network_signature: 'teemo\\.co',
      website: 'https://teemo.co',
      creation_date: '2017-11-06'
    }
  })));

  assert.deepEqual(Object.keys(data), ['trackers']);
  assert.deepEqual(data.trackers['1'], { id: 1, name: 'Teemo', categories: ['Analytics', 'Location'] });
});

test('sorts keys numerically and categories alphabetically', () => {
  const data = updater.normalise(payload(sample({
    10: { id: 10, name: 'Ten', categories: ['Profiling', 'Advertisement'] },
    2: { id: 2, name: 'Two', categories: [] }
  })));

  const keys = Object.keys(data.trackers).filter((key) => key === '2' || key === '10');
  assert.deepEqual(keys, ['2', '10']);
  assert.deepEqual(data.trackers['10'].categories, ['Advertisement', 'Profiling']);
});

test('category reordering alone does not change the serialised file', () => {
  const before = updater.normalise(payload(sample({
    1: { id: 1, name: 'Teemo', categories: ['Analytics', 'Location'] }
  })));
  const after = updater.normalise(payload(sample({
    1: { id: 1, name: 'Teemo', categories: ['Location', 'Analytics'] }
  })));

  assert.equal(updater.serialise(before), updater.serialise(after));
  assert.equal(updater.changeCount(updater.diff(before, after)), 0);
});

test('rejects a truncated or malformed payload', () => {
  assert.throws(() => updater.normalise('not json'), /not valid JSON/);
  assert.throws(() => updater.normalise('{}'), /no top-level 'trackers'/);
  assert.throws(() => updater.normalise(payload({})), /empty or not an object/);
  assert.throws(() => updater.normalise(payload({ 1: { id: 1, name: 'Teemo' } })), /looks truncated/);
  assert.throws(
    () => updater.normalise(payload(sample({ 1: { id: 1, categories: [] } }))),
    /missing 'name'/
  );
  assert.throws(
    () => updater.normalise(payload(sample({ 1: { id: 1, name: 'Teemo', categories: 'Analytics' } }))),
    /non-array 'categories'/
  );
});

test('reports additions, removals, renames and category changes', () => {
  const before = updater.normalise(payload(sample({
    1: { id: 1, name: 'Gigya', categories: ['Identification'] },
    2: { id: 2, name: 'MixPanel', categories: ['Advertisement', 'Analytics'] },
    3: { id: 3, name: 'Gone', categories: [] }
  })));
  const after = updater.normalise(payload(sample({
    1: { id: 1, name: 'SAP CDC (Gigya)', categories: ['Identification'] },
    2: { id: 2, name: 'MixPanel', categories: ['Analytics'] },
    4: { id: 4, name: 'Sentry', categories: ['Crash reporters'] }
  }, ['3'])));

  const changes = updater.diff(before, after);
  assert.deepEqual(changes.added.map((entry) => entry.name), ['Sentry']);
  assert.deepEqual(changes.removed.map((entry) => entry.name), ['Gone']);
  assert.deepEqual(changes.renamed, [{ from: 'Gigya', to: 'SAP CDC (Gigya)' }]);
  assert.deepEqual(changes.recategorised, [
    { name: 'MixPanel', from: ['Advertisement', 'Analytics'], to: ['Analytics'] }
  ]);
  assert.equal(updater.changeCount(changes), 4);

  const summary = updater.summarise(changes, 3);
  assert.match(summary, /### Added \(1\)/);
  assert.match(summary, /- Sentry — Crash reporters/);
  assert.match(summary, /- Gigya → SAP CDC \(Gigya\)/);
  assert.match(summary, /- MixPanel: Advertisement, Analytics → Analytics/);
});

// Pads a fixture up past the truncation guard with filler entries, so tests can
// state just the entries they care about.
function sample(trackers, omit = []) {
  const padded = { ...trackers };
  for (let id = 1000; Object.keys(padded).length < 120; id++)
    padded[String(id)] = { id, name: `Filler ${id}`, categories: [] };
  for (const key of omit) delete padded[key];
  return padded;
}
