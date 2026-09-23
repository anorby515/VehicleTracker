'use strict';
/**
 * Builds the front end's mock data from the synthetic journal
 * (test/fixtures/sheet.js): one full Bootstrap per fictional App Users row,
 * made by the real getBootstrap_() with in-memory fakes, on the fixture's TODAY.
 *
 * Writes web/src/mock/bootstrap.<first name>.json and web/src/mock/index.json
 * ({users: [{email, name, file}]}, read by web/src/api/mock.ts).
 *
 *   npm run fixture      (from apps-script/)
 */
process.env.TZ = 'America/Chicago'; // the fixture's dates are local noon in Chicago

const fs = require('fs');
const path = require('path');
const { load } = require('./harness');
const { makeFakes } = require('./fakes');
const fixture = require('./fixtures/sheet');

const OUT_DIR = path.join(__dirname, '..', '..', 'web', 'src', 'mock');
const FILES = ['Config.js', 'Dates.js', 'Sheet.js', 'Model.js', 'Logic.js', 'Bootstrap.js'];
/** A fixed generation time on the fixture's TODAY, so the output is stable. */
const NOW = new Date(fixture.TODAY + 'T09:30:00-05:00');

/** @return {{index: {users: object[]}, files: Object<string, object>}} */
function buildMocks() {
  const fakes = makeFakes({ tabs: fixture.tabs, props: { OWNER_EMAIL: fixture.users.owner } });
  const gas = load({ files: FILES, globals: fakes.globals });
  const users = gas.dataFromTabs_(fixture.tabs).appUsers.filter(u => u.active);
  const index = { users: [] };
  const files = {};
  users.forEach(u => {
    // Round-trip through JSON: plain objects, exactly what the API would send.
    const b = JSON.parse(JSON.stringify(gas.getBootstrap_(u.email, NOW)));
    const file = 'bootstrap.' + b.user.name.split(/\s+/)[0].toLowerCase() + '.json';
    files[file] = b;
    index.users.push({ email: b.user.email, name: b.user.name, file: file });
  });
  return { index, files };
}

function main() {
  const { index, files } = buildMocks();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  Object.keys(files).forEach(name => {
    fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(files[name], null, 2) + '\n');
  });
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log('Wrote ' + Object.keys(files).concat('index.json').map(f => path.relative(process.cwd(), path.join(OUT_DIR, f))).join(', '));
}

if (require.main === module) main();

module.exports = { buildMocks, NOW };
