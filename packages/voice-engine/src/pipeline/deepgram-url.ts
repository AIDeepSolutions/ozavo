/** Parâmetros compartilhados pela bancada e pelo motor de produção. */
export function recognitionUrl(base: string, language: string, sampleRate: number, vocabulary: readonly string[], model = "nova-3"): URL {
  const url = new URL(base);
  const parameters = {
    model, language, encoding: "linear16", sample_rate: String(sampleRate), channels: "1",
    interim_results: "true", punctuate: "true", smart_format: "true",
  };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  for (const term of vocabulary.slice(0, 100)) url.searchParams.append("keyterm", term);
  return url;
}
