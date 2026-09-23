'use strict';
/**
 * Guardrail: Apps Script runs every file's top level in push order, and clasp
 * pushes alphabetically (Api.js, Auth.js and Bootstrap.js before Config.js).
 * A top-level `const X = RULES.Y` in a file that sorts before Config.js works
 * in a Config-first test harness and breaks in production. So:
 *   - every file's top level must run ALONE, with no other file loaded;
 *   - the harness loads files in plain alphabetical order;
 *   - .clasp.json.example still pushes Config.js and Dates.js first (belt and braces).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load, orderFiles, ROOT } = require('./harness');

const FILES = fs.readdirSync(ROOT).filter(f => f.endsWith('.js')).sort();

test('every Apps Script file\'s top level runs with no other file loaded (no load-order dependency)', () => {
  for (const f of FILES) {
    const context = vm.createContext({ console });
    assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), context, { filename: f }), f);
  }
});

test('no two files declare the same top-level name (Apps Script shares one global scope)', () => {
  const seen = {};
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/^(?:function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+))/gm)) {
      const name = m[1] || m[2];
      assert.ok(!seen[name], name + ' is declared in both ' + seen[name] + ' and ' + f);
      seen[name] = f;
    }
  }
});

test('the harness loads files alphabetically, even when a test lists Config.js first', () => {
  assert.deepEqual(orderFiles(['Config.js', 'Dates.js', 'Sheet.js', 'Api.js', 'Auth.js', 'Bootstrap.js']),
    ['Api.js', 'Auth.js', 'Bootstrap.js', 'Config.js', 'Dates.js', 'Sheet.js']);
  // Loaded that way, functions still see Config.js at call time.
  const gas = load({ files: ['Config.js', 'Api.js'] });
  assert.equal(typeof gas.routes_().uploadChunk.params.data.max, 'number');
});

test('.clasp.json.example pushes Config.js and Dates.js first', () => {
  const clasp = JSON.parse(fs.readFileSync(path.join(ROOT, '.clasp.json.example'), 'utf8'));
  assert.deepEqual(clasp.filePushOrder, ['Config.js', 'Dates.js']);
  assert.equal(clasp.rootDir, '.');
});
