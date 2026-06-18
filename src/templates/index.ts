/** Template registry. Add a deployable by importing it and adding it here. */
import type { Template } from "./types.js";
import { qvacTemplate } from "./qvac.js";

const TEMPLATES: Record<string, Template> = {
  [qvacTemplate.id]: qvacTemplate,
};

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES[id];
}

export function listTemplates(): Template[] {
  return Object.values(TEMPLATES);
}

export type { Template } from "./types.js";
