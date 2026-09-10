import { parse, TomlError, type TomlValue } from "smol-toml";

export type { TomlValue };

/** Parse standards-compliant TOML; AgentConfig schema validation is a separate step. */
export function parseToml(text: string): Record<string, TomlValue> {
  try {
    return parse(text);
  } catch (error) {
    if (error instanceof TomlError) throw new Error(`TOML 解析失败: ${error.message}`, { cause: error });
    throw error;
  }
}
