// Tiny test harness.
//
// The point of this file is one property: run() waits for every test. Two
// earlier projects reported "all passed" from a summary line that executed
// before the async tests finished, which turns a green suite into a lie.

const tests = [];
let currentFile = "";

export function test(name, fn) {
  tests.push({ name, fn, file: currentFile });
}

export function setFile(name) {
  currentFile = name;
}

const OK = (s) => `  ok    ${s}`;
const BAD = (s) => `  FAIL  ${s}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const eq = (actual, expected, message = "") => {
  const a = typeof actual === "bigint" ? `${actual}n` : JSON.stringify(actual);
  const e = typeof expected === "bigint" ? `${expected}n` : JSON.stringify(expected);
  assert(a === e, `${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
};

export const throws = (fn, matcher, message = "") => {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, `${message ? `${message}: ` : ""}expected a throw, nothing was thrown`);
  if (matcher) {
    const text = `${threw.name}: ${threw.message}${threw.field ? ` [field=${threw.field}]` : ""}`;
    const ok = typeof matcher === "string" ? text.includes(matcher) : matcher.test(text);
    assert(ok, `${message ? `${message}: ` : ""}error did not match ${matcher}; got ${text}`);
  }
  return threw;
};

export const near = (actual, expected, tolerance, message = "") => {
  assert(
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `${message ? `${message}: ` : ""}expected ~${expected} (±${tolerance}), got ${actual}`,
  );
};

/** Run everything, waiting on each test in turn. Returns the failure count. */
export async function run() {
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      console.log(OK(t.name));
    } catch (err) {
      failures.push({ name: t.name, error: err });
      console.log(BAD(t.name));
      console.log(`        ${err.message.split("\n")[0]}`);
    }
  }
  console.log("");
  if (failures.length > 0) {
    console.log(`${failures.length} of ${tests.length} failed:`);
    for (const f of failures) console.log(`  - ${f.name}`);
    return failures.length;
  }
  console.log(`all ${tests.length} tests passed`);
  return 0;
}
