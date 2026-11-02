// Calculadora segura: analisador recursivo-descendente. NÃO usa eval/Function.
// Gramática: expr := term (('+'|'-') term)* ; term := power (('*'|'/'|'%') power)* ;
//            unary := '-' unary | power ; power := primary ('^' unary)? ;
//            primary := número | const | func '(' args ')' | '(' expr ')'

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  ln: Math.log,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  min: Math.min,
  max: Math.max,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export class CalcError extends Error {}

export function calculate(input: string): number {
  if (input.length > 200) throw new CalcError('Expressão longa demais.');
  const src = input.replace(/\s+/g, '').toLowerCase().replace(/,/g, '.');
  let i = 0;
  let depth = 0;

  const peek = () => src[i];
  const eat = (c: string) => {
    if (src[i] !== c) throw new CalcError(`Esperado "${c}" na posição ${i}.`);
    i++;
  };

  function expr(): number {
    let v = term();
    while (peek() === '+' || peek() === '-') v = src[i++] === '+' ? v + term() : v - term();
    return v;
  }
  function term(): number {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = src[i++];
      const r = unary();
      if ((op === '/' || op === '%') && r === 0) throw new CalcError('Divisão por zero.');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function unary(): number {
    if (peek() === '-') {
      i++;
      return -unary(); // -2^2 = -(2^2)
    }
    if (peek() === '+') {
      i++;
      return unary();
    }
    return power();
  }
  function power(): number {
    const base = primary();
    if (peek() === '^') {
      i++;
      return Math.pow(base, unary()); // direita-associativo; aceita 2^-1
    }
    return base;
  }
  function primary(): number {
    if (++depth > 50) throw new CalcError('Aninhamento excessivo.');
    try {
      if (peek() === '(') {
        i++;
        const v = expr();
        eat(')');
        return v;
      }
      const num = /^\d+(\.\d+)?(e[+-]?\d+)?/.exec(src.slice(i));
      if (num) {
        i += num[0].length;
        return Number(num[0]);
      }
      const id = /^[a-z][a-z0-9]*/.exec(src.slice(i));
      if (id) {
        i += id[0].length;
        const name = id[0];
        if (peek() === '(') {
          const fn = FUNCS[name];
          if (!fn) throw new CalcError(`Função desconhecida: ${name}.`);
          i++;
          const args: number[] = [];
          if (peek() !== ')') {
            args.push(expr());
            while (peek() === ';') {
              i++;
              args.push(expr());
            }
          }
          eat(')');
          return fn(...args);
        }
        if (name in CONSTS) return CONSTS[name]!;
        throw new CalcError(`Identificador desconhecido: ${name}.`);
      }
      throw new CalcError(`Caractere inesperado na posição ${i}.`);
    } finally {
      depth--;
    }
  }

  const result = expr();
  if (i !== src.length) throw new CalcError(`Sobrou texto na posição ${i}.`);
  if (!Number.isFinite(result)) throw new CalcError('Resultado não finito.');
  return result;
}
