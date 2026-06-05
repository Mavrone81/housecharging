// Safe arithmetic formula evaluator — NO eval / NO Function constructor.
// Supports: + - * / %, parentheses, numbers, the variables
// prev, curr, usage, rate, fixed, and the functions min, max, round, abs.
// Anything else is rejected, so admin-entered formulas cannot run code.

const VARS = new Set(['prev', 'curr', 'usage', 'rate', 'fixed']);
const FUNCS = {
  min: Math.min, max: Math.max, round: Math.round, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil,
};
const OPS = {
  '+': { prec: 2, assoc: 'L', fn: (a, b) => a + b },
  '-': { prec: 2, assoc: 'L', fn: (a, b) => a - b },
  '*': { prec: 3, assoc: 'L', fn: (a, b) => a * b },
  '/': { prec: 3, assoc: 'L', fn: (a, b) => a / b },
  '%': { prec: 3, assoc: 'L', fn: (a, b) => a % b },
};

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c >= '0' && c <= '9' || c === '.') {
      let j = i + 1;
      while (j < expr.length && (expr[j] >= '0' && expr[j] <= '9' || expr[j] === '.')) j++;
      const num = Number(expr.slice(i, j));
      if (!Number.isFinite(num)) throw new Error('bad number');
      tokens.push({ t: 'num', v: num });
      i = j; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
      const name = expr.slice(i, j);
      if (VARS.has(name)) tokens.push({ t: 'var', v: name });
      else if (FUNCS[name]) tokens.push({ t: 'func', v: name });
      else throw new Error('unknown identifier: ' + name);
      i = j; continue;
    }
    if (OPS[c]) { tokens.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(') { tokens.push({ t: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ t: 'rparen' }); i++; continue; }
    if (c === ',') { tokens.push({ t: 'comma' }); i++; continue; }
    throw new Error('illegal character: ' + c);
  }
  return tokens;
}

// Shunting-yard to Reverse Polish Notation, with unary minus handling.
function toRPN(tokens) {
  const out = [];
  const stack = [];
  let prev = null;
  for (const tok of tokens) {
    if (tok.t === 'num' || tok.t === 'var') {
      out.push(tok);
    } else if (tok.t === 'func') {
      stack.push(tok);
    } else if (tok.t === 'comma') {
      while (stack.length && stack[stack.length - 1].t !== 'lparen') out.push(stack.pop());
      if (!stack.length) throw new Error('misplaced comma');
    } else if (tok.t === 'op') {
      // unary minus / plus
      const unary = (tok.v === '-' || tok.v === '+') &&
        (prev === null || prev.t === 'op' || prev.t === 'lparen' || prev.t === 'comma');
      if (unary) {
        if (tok.v === '-') { out.push({ t: 'num', v: 0 }); stack.push({ t: 'op', v: '-' }); }
        // unary plus: no-op
        prev = tok; continue;
      }
      const o1 = OPS[tok.v];
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.t === 'op') {
          const o2 = OPS[top.v];
          if ((o1.assoc === 'L' && o1.prec <= o2.prec) || (o1.assoc === 'R' && o1.prec < o2.prec)) {
            out.push(stack.pop()); continue;
          }
        }
        break;
      }
      stack.push(tok);
    } else if (tok.t === 'lparen') {
      stack.push(tok);
    } else if (tok.t === 'rparen') {
      while (stack.length && stack[stack.length - 1].t !== 'lparen') out.push(stack.pop());
      if (!stack.length) throw new Error('mismatched parentheses');
      stack.pop(); // remove lparen
      if (stack.length && stack[stack.length - 1].t === 'func') out.push(stack.pop());
    }
    prev = tok;
  }
  while (stack.length) {
    const top = stack.pop();
    if (top.t === 'lparen' || top.t === 'rparen') throw new Error('mismatched parentheses');
    out.push(top);
  }
  return out;
}

function evalRPN(rpn, scope) {
  const st = [];
  for (const tok of rpn) {
    if (tok.t === 'num') st.push(tok.v);
    else if (tok.t === 'var') st.push(scope[tok.v]);
    else if (tok.t === 'op') {
      const b = st.pop(), a = st.pop();
      if (a === undefined || b === undefined) throw new Error('bad expression');
      st.push(OPS[tok.v].fn(a, b));
    } else if (tok.t === 'func') {
      // min/max/round/abs — support 1 or 2 args (we evaluate greedily: pop up to 2)
      const fn = FUNCS[tok.v];
      const arity = (tok.v === 'min' || tok.v === 'max') ? 2 : 1;
      const args = [];
      for (let k = 0; k < arity; k++) args.unshift(st.pop());
      if (args.some(x => x === undefined)) throw new Error('bad function args');
      st.push(fn(...args));
    }
  }
  if (st.length !== 1) throw new Error('bad expression');
  return st[0];
}

const cache = new Map();
function compile(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return null;
  if (cache.has(expr)) return cache.get(expr);
  let rpn = null;
  try { rpn = toRPN(tokenize(expr)); } catch { rpn = null; }
  cache.set(expr, rpn);
  return rpn;
}

// Validate a formula by compiling and test-evaluating with sample values.
export function isValidFormula(expr) {
  const rpn = compile(expr);
  if (!rpn) return false;
  try {
    const v = evalRPN(rpn, { prev: 100, curr: 120, usage: 20, rate: 18, fixed: 30 });
    return typeof v === 'number' && Number.isFinite(v);
  } catch { return false; }
}

// Evaluate; returns NaN if the formula is invalid (caller should fall back).
export function evalFormula(expr, { prev, curr, rate, fixed }) {
  const rpn = compile(expr);
  if (!rpn) return NaN;
  try {
    const v = evalRPN(rpn, { prev, curr, usage: curr - prev, rate, fixed });
    return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
  } catch { return NaN; }
}

export const DEFAULT_FORMULA = '(curr - prev) * rate + fixed';
