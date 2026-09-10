import { encodingForModel, getEncoding, type Tiktoken, type TiktokenModel } from "js-tiktoken";
import type { SkillTokenizer } from "./platform.js";

export interface TokenizerDescription {
  model?: string;
  encoding: string;
  modelMatched: boolean;
}

/** Uses the same BPE implementation as tiktoken. Unknown provider models use
 * an explicit encoding fallback and are reported as not model-matched. */
export class TiktokenSkillTokenizer implements SkillTokenizer {
  private readonly encoders = new Map<string, Tiktoken>();
  private readonly matchedModels = new Map<string, boolean>();
  private lastDescription: TokenizerDescription = { encoding: "cl100k_base", modelMatched: false };

  constructor(private readonly fallbackEncoding: "cl100k_base" | "o200k_base" = "cl100k_base") {}

  count(text: string, model?: string): number {
    const key = model || `encoding:${this.fallbackEncoding}`;
    let encoder = this.encoders.get(key);
    let modelMatched = false;
    if (!encoder) {
      if (model) {
        try {
          encoder = encodingForModel(model as TiktokenModel);
          modelMatched = true;
        } catch {
          encoder = getEncoding(this.fallbackEncoding);
        }
      } else {
        encoder = getEncoding(this.fallbackEncoding);
      }
      this.encoders.set(key, encoder);
      this.matchedModels.set(key, modelMatched);
    } else modelMatched = this.matchedModels.get(key) ?? false;
    this.lastDescription = { ...(model ? { model } : {}), encoding: modelMatched ? model! : this.fallbackEncoding, modelMatched };
    return encoder.encode(text).length;
  }

  describe(): TokenizerDescription { return { ...this.lastDescription }; }
}
