import { z } from "zod";
import {
  createExternalTool,
  type ExternalTool,
} from "@moonshot-ai/kimi-agent-sdk";
import type { Project, Task } from "../../types";
import {
  createSuggestedTask,
  proposeCardChange,
  publishWorkstreamUpdate,
  registerExposedService,
} from "../../agentTools";
import { publishTaskArtifact } from "../../artifactTool";
import {
  EXPOSE_SERVICE,
  PUBLISH_ARTIFACT,
  PUBLISH_WORKSTREAM_UPDATE,
  PROPOSE_CARD_CHANGE,
  SUGGEST_TASK,
} from "../../agentToolDefs.mjs";

export function kimiCodeOperatorTools(
  task: Task,
  project: Project,
  onSuggested: (title: string) => void,
): ExternalTool[] {
  return [
    createExternalTool({
      name: SUGGEST_TASK.name,
      description: SUGGEST_TASK.description,
      parameters: z.object({
        title: z.string().min(1),
        description: z.string(),
        priority: z.enum(["hi", "med", "lo"]).default("med"),
      }),
      handler: async (params) => {
        const result = createSuggestedTask(project, params);
        onSuggested(params.title);
        return { output: result.text, message: result.text };
      },
    }),
    createExternalTool({
      name: EXPOSE_SERVICE.name,
      description: EXPOSE_SERVICE.description,
      parameters: z.object({
        name: z.string().min(1),
        port: z.number().int().positive(),
      }),
      handler: async ({ name, port }) => {
        const result = registerExposedService(project, name, port);
        return { output: result.text, message: result.text };
      },
    }),
    createExternalTool({
      name: PUBLISH_ARTIFACT.name,
      description: PUBLISH_ARTIFACT.description,
      parameters: z.object({
        path: z.string().min(1),
        title: z.string().optional(),
      }),
      handler: async (params) => {
        const result = publishTaskArtifact(task, project, params);
        return { output: result.text, message: result.text };
      },
    }),
    createExternalTool({
      name: PUBLISH_WORKSTREAM_UPDATE.name,
      description: PUBLISH_WORKSTREAM_UPDATE.description,
      parameters: z.object({
        body: z.string().min(1).max(20_000),
        files: z.array(z.string()).max(5).optional(),
      }),
      handler: async (params) => {
        const result = await publishWorkstreamUpdate(task, project, params);
        return { output: result.text, message: result.text };
      },
    }),
    createExternalTool({
      name: PROPOSE_CARD_CHANGE.name,
      description: PROPOSE_CARD_CHANGE.description,
      parameters: z.object({
        kind: z.enum(["card_update", "complete_card", "archive_card"]),
        value: z.record(z.string(), z.unknown()),
      }),
      handler: async (params) => {
        const result = await proposeCardChange(task, project, params);
        return { output: result.text, message: result.text };
      },
    }),
  ];
}
