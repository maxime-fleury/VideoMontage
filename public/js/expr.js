/**
 * Évaluateur d'expressions minimal, partagé par l'aperçu (navigateur) et les tests.
 *
 * Les mouvements prédéfinis sont décrits une seule fois comme des chaînes
 * d'expression (voir src/lib/motions.ts) : ffmpeg reçoit la chaîne telle quelle,
 * l'aperçu l'évalue ici. Une seule vérité, donc aucun écart entre ce que tu vois
 * dans le preview et ce qui sort du rendu.
 *
 * Supporte : nombres, + - * / %, parenthèses, moins unaire, comparaisons simples,
 * et les fonctions min, max, abs, floor, ceil, round, sin, cos, sqrt, if.
 *
 * Les comparaisons existent en deux formes : les opérateurs `<`, `>`, `<=`, `>=`
 * et les fonctions `lt`, `gt`, `lte`, `gte`, `eq` de ffmpeg. Les expressions
 * partagées (images clés) utilisent les fonctions : les opérateurs cassent le
 * parseur d'expressions de ffmpeg.
 */

const cmp = (fn) => (a, b) => (fn(a, b) ? 1 : 0);

const FUNCTIONS = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sin: Math.sin,
  cos: Math.cos,
  sqrt: Math.sqrt,
  pow: Math.pow,
  lt: cmp((a, b) => a < b),
  gt: cmp((a, b) => a > b),
  lte: cmp((a, b) => a <= b),
  gte: cmp((a, b) => a >= b),
  eq: cmp((a, b) => a === b),
};

const CONSTANTS = { PI: Math.PI, E: Math.E };

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const char = src[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      if (!/^\d*\.?\d+$/.test(raw)) throw new Error(`Nombre invalide : ${raw}`);
      tokens.push({ type: "number", value: Number(raw) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ type: "name", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%(),<>=?".includes(char)) {
      // « <= » et « >= » restent des jetons simples pour l'opérateur if().
      if ((char === "<" || char === ">") && src[i + 1] === "=") {
        tokens.push({ type: "op", value: `${char}=` });
        i += 2;
        continue;
      }
      tokens.push({ type: "op", value: char });
      i++;
      continue;
    }
    throw new Error(`Caractère inattendu « ${char} »`);
  }
  return tokens;
}

/** Analyse et évalue `src` avec les variables fournies. */
export function evalExpr(src, vars = {}) {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (value) => {
    const token = tokens[pos];
    if (!token || token.value !== value) throw new Error(`Attendu « ${value} »`);
    pos++;
    return token;
  };

  function parseExpression() {
    let left = parseAdditive();
    const token = peek();
    if (token && (token.value === "<" || token.value === ">" || token.value === "<=" || token.value === ">=")) {
      pos++;
      const right = parseAdditive();
      const a = left;
      const b = right;
      left = token.value === "<" ? (a < b ? 1 : 0) : token.value === ">" ? (a > b ? 1 : 0) : token.value === "<=" ? (a <= b ? 1 : 0) : a >= b ? 1 : 0;
    }
    return left;
  }

  function parseAdditive() {
    let value = parseMultiplicative();
    while (true) {
      const token = peek();
      if (!token || (token.value !== "+" && token.value !== "-")) return value;
      pos++;
      const right = parseMultiplicative();
      value = token.value === "+" ? value + right : value - right;
    }
  }

  function parseMultiplicative() {
    let value = parseUnary();
    while (true) {
      const token = peek();
      if (!token || !["*", "/", "%"].includes(token.value)) return value;
      pos++;
      const right = parseUnary();
      if (token.value === "*") value *= right;
      else if (token.value === "/") value = value / right;
      else value = value % right;
    }
  }

  function parseUnary() {
    const token = peek();
    if (token && token.value === "-") {
      pos++;
      return -parseUnary();
    }
    if (token && token.value === "+") {
      pos++;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = peek();
    if (!token) throw new Error("Expression incomplète");
    if (token.type === "number") {
      pos++;
      return token.value;
    }
    if (token.value === "(") {
      pos++;
      const value = parseExpression();
      eat(")");
      return value;
    }
    if (token.type === "name") {
      pos++;
      const name = token.value;
      if (peek()?.value === "(") {
        pos++;
        const args = [];
        if (peek()?.value !== ")") {
          args.push(parseExpression());
          while (peek()?.value === ",") {
            pos++;
            args.push(parseExpression());
          }
        }
        eat(")");
        if (name === "if") return args[0] ? args[1] : args[2];
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`Fonction inconnue : ${name}`);
        return fn(...args);
      }
      if (name === "if") throw new Error("if() attend trois arguments");
      if (name in CONSTANTS) return CONSTANTS[name];
      if (name in vars) return vars[name];
      throw new Error(`Variable inconnue : ${name}`);
    }
    throw new Error(`Jeton inattendu « ${token.value} »`);
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error("Expression mal formée");
  return result;
}

/** Remplace les variables symboliques d'un gabarit par leurs valeurs. */
export function fillTemplate(template, values) {
  return String(template).replace(/\b[A-Z]{1,3}\b/g, (token) => {
    if (!(token in values)) return token;
    const value = values[token];
    return typeof value === "number" ? Number(value.toFixed(4)).toString() : String(value);
  });
}
