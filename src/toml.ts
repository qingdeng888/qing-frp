/** Minimal TOML emitters — enough for frp's config surface. */

export function escapeString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export function tstr(value: string): string {
  return `"${escapeString(value)}"`;
}

export function tbool(value: boolean): string {
  return value ? 'true' : 'false';
}

export function tarr(values: string[]): string {
  return `[${values.map((v) => tstr(v)).join(', ')}]`;
}

/** Quote an object key when it contains characters TOML would reject bare. */
export function tkey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tstr(key);
}

export class TomlWriter {
  private lines: string[] = [];

  comment(text: string): this {
    this.lines.push(`# ${text}`);
    return this;
  }

  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  kv(keyPath: string, value: string | number | boolean | null | undefined): this {
    if (value === null || value === undefined) return this;
    const rendered =
      typeof value === 'string' ? tstr(value) : typeof value === 'boolean' ? tbool(value) : String(value);
    this.lines.push(`${keyPath} = ${rendered}`);
    return this;
  }

  /** Emit a `key = value` line where value is already TOML-encoded. */
  rawKv(keyPath: string, encodedValue: string): this {
    this.lines.push(`${keyPath} = ${encodedValue}`);
    return this;
  }

  table(header: string): this {
    this.lines.push('');
    this.lines.push(header);
    return this;
  }

  blank(): this {
    this.lines.push('');
    return this;
  }

  toString(): string {
    return this.lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
}
