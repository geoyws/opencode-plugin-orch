import type { ModelRef } from "../state/schemas.js";
import { codeReviewTemplate } from "./code-review.js";
import { featureBuildTemplate } from "./feature-build.js";
import { debugSquadTemplate } from "./debug-squad.js";

export interface TemplateMember {
  role: string;
  agent?: string;
  model?: ModelRef;
  instructions: string;
}

export interface TeamTemplate {
  name: string;
  description: string;
  members: TemplateMember[];
}

export class TemplateRegistry {
  private templates = new Map<string, TeamTemplate>();

  constructor() {
    // Register built-in templates
    this.register(codeReviewTemplate);
    this.register(featureBuildTemplate);
    this.register(debugSquadTemplate);
  }

  register(template: TeamTemplate): void {
    this.templates.set(template.name, template);
  }

  get(name: string): TeamTemplate | undefined {
    return this.templates.get(name);
  }

  list(): string[] {
    return [...this.templates.keys()];
  }

  async loadCustomTemplates(dir: string): Promise<void> {
    // Load from .opencode/plugin-orch/templates/*.json
    const fs = await import("node:fs");
    const path = await import("node:path");
    const templatesDir = path.join(dir, ".opencode", "plugin-orch", "templates");
    if (!fs.existsSync(templatesDir)) return;

    const files = fs.readdirSync(templatesDir).filter((f: string) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(templatesDir, file), "utf-8");
        const tmpl: TeamTemplate = JSON.parse(raw);
        if (tmpl.name && tmpl.members) {
          this.register(tmpl);
        }
      } catch {
        // Skip invalid templates
      }
    }
  }
}
