/* eslint-disable */
/**
 * Micro-benchmark for class-transformer.
 *
 * Usage: node benchmark/run.js <path-to-built-cjs-lib> [label]
 * Example:
 *   npx tsc -p tsconfig.prod.cjs.json --outDir build/bench && node benchmark/run.js ./build/bench
 *
 * BENCH_FILTER=<substring> only runs the matching cases, BENCH_JSON=<file> writes the results to a JSON file.
 *
 * Every lib build must be run in its own process: the metadata storage lives on globalThis.
 */
require('reflect-metadata');
const path = require('path');
const libPath = path.resolve(process.argv[2] || './build/cjs');
const label = process.argv[3] || libPath;
const ct = require(libPath);
const { Type, Expose, Exclude, Transform, plainToInstance, instanceToPlain, instanceToInstance } = ct;

const dec = (decorator, cls, prop, designType) => {
  decorator(cls.prototype, prop);
  if (designType) Reflect.defineMetadata('design:type', designType, cls.prototype, prop);
};

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
class Flat {}
// no decorators at all: id, name, email, age, active

class Photo {}
dec(Expose(), Photo, 'id');
dec(Expose(), Photo, 'url');
dec(Expose(), Photo, 'width');
dec(Expose(), Photo, 'height');

class Address {}
dec(Expose(), Address, 'street');
dec(Expose(), Address, 'city');
dec(Expose(), Address, 'zip');

class User {
  get fullName() {
    return this.firstName + ' ' + this.lastName;
  }
}
dec(Expose(), User, 'id');
dec(Expose(), User, 'firstName');
dec(Expose(), User, 'lastName');
dec(Expose({ name: 'email_address' }), User, 'email');
dec(Exclude({ toPlainOnly: true }), User, 'password');
dec(
  Type(() => Date),
  User,
  'createdAt'
);
dec(
  Type(() => Address),
  User,
  'address'
);
dec(
  Type(() => Photo),
  User,
  'photos'
);
dec(
  Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value), { toClassOnly: true }),
  User,
  'country'
);
dec(Expose(), User, 'country');
dec(Expose(), User, 'createdAt');
dec(Expose(), User, 'address');
dec(Expose(), User, 'photos');
dec(Expose(), User, 'password');
dec(Expose({ groups: ['admin'] }), User, 'role');

class Implicit {}
dec(Expose(), Implicit, 'id', Number);
dec(Expose(), Implicit, 'price', Number);
dec(Expose(), Implicit, 'name', String);
dec(Expose(), Implicit, 'active', Boolean);
dec(Expose(), Implicit, 'quantity', Number);

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const flatPlain = { id: 1, name: 'John', email: 'john@example.com', age: 31, active: true };

const makeUserPlain = i => ({
  id: i,
  firstName: 'John' + i,
  lastName: 'Doe',
  email_address: 'john' + i + '@example.com',
  password: 'secret',
  country: 'vn',
  role: 'admin',
  createdAt: '2024-01-01T00:00:00.000Z',
  address: { street: '1 Main St', city: 'Hanoi', zip: '10000' },
  photos: [
    { id: 1, url: 'a.png', width: 100, height: 100 },
    { id: 2, url: 'b.png', width: 200, height: 150 },
    { id: 3, url: 'c.png', width: 300, height: 250 },
  ],
});
const userPlain = makeUserPlain(1);
const users1000 = Array.from({ length: 1000 }, (_, i) => makeUserPlain(i));
const userInstance = plainToInstance(User, userPlain);
const userInstances1000 = plainToInstance(User, users1000);
const implicitPlain = { id: '42', price: '19.99', name: 123, active: 'true', quantity: '7', extra: 'x' };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let sink;
function bench(name, fn, minMs = 300, samples = 7) {
  // warm-up
  const warmEnd = Date.now() + 200;
  while (Date.now() < warmEnd) sink = fn();
  const results = [];
  for (let s = 0; s < samples; s++) {
    let ops = 0;
    const start = process.hrtime.bigint();
    let elapsed = 0n;
    const budget = BigInt(minMs) * 1000000n;
    while (elapsed < budget) {
      for (let i = 0; i < 16; i++) sink = fn();
      ops += 16;
      elapsed = process.hrtime.bigint() - start;
    }
    results.push((ops * 1e9) / Number(elapsed));
  }
  results.sort((a, b) => a - b);
  return { name, opsPerSec: results[Math.floor(results.length / 2)] };
}

const cases = [
  ['plainToInstance flat (no decorators)', () => plainToInstance(Flat, flatPlain)],
  ['plainToInstance nested User', () => plainToInstance(User, userPlain)],
  [
    'plainToInstance nested User (excludeExtraneousValues)',
    () => plainToInstance(User, userPlain, { excludeExtraneousValues: true }),
  ],
  ['plainToInstance nested User (groups: admin)', () => plainToInstance(User, userPlain, { groups: ['admin'] })],
  ['plainToInstance 1000 Users', () => plainToInstance(User, users1000)],
  ['instanceToPlain nested User', () => instanceToPlain(userInstance)],
  ['instanceToPlain 1000 Users', () => instanceToPlain(userInstances1000)],
  ['instanceToInstance nested User', () => instanceToInstance(userInstance)],
  [
    'plainToInstance implicit conversion',
    () => plainToInstance(Implicit, implicitPlain, { enableImplicitConversion: true }),
  ],
  [
    'plainToInstance nested User (enableCircularCheck)',
    () => plainToInstance(User, userPlain, { enableCircularCheck: true }),
  ],
];

// BENCH_FILTER=<substring> runs only the matching cases
const filter = process.env.BENCH_FILTER;
const out = {};
for (const [name, fn] of cases.filter(([name]) => !filter || name.includes(filter))) {
  const r = bench(name, fn);
  out[name] = r.opsPerSec;
  console.error(
    `${label.padEnd(8)} ${name.padEnd(56)} ${Math.round(r.opsPerSec).toLocaleString('en-US').padStart(12)} ops/s`
  );
}
if (process.env.BENCH_JSON) require('fs').writeFileSync(process.env.BENCH_JSON, JSON.stringify(out, null, 2));
