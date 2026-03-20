import { f as Workflow, e as WorkflowFrontmatter, j as Cell, k as CellOutput } from '../index-DIxOf9vK.js';
import 'zod';

/**
 * @vaultore/core - Workflow Parser
 *
 * BRICK-002: Parses workflow notes into structured data
 *
 * Responsibilities:
 * - Extract and validate frontmatter
 * - Parse ore:* code blocks into Cell objects
 * - Extract existing outputs from HTML comments
 * - Reconstruct workflow from parts
 */

declare class WorkflowParser {
    /**
     * Parse a complete workflow from markdown content
     */
    parse(content: string, path: string): Workflow;
    /**
     * Check if content is a valid workflow
     */
    isWorkflow(content: string): boolean;
    /**
     * Parse and validate frontmatter
     */
    parseFrontmatter(content: string): WorkflowFrontmatter;
    /**
     * Parse all ore:* code blocks into Cell objects
     */
    parseCells(content: string): Cell[];
    /**
     * Parse cell attributes
     */
    private parseAttributes;
    /**
     * Parse existing outputs from HTML comments
     */
    parseOutputs(content: string): Map<string, CellOutput>;
    /**
     * Parse ore-output callout stubs to locate persisted output files.
     */
    parseOutputStubs(content: string): Map<string, {
        outputPath?: string;
        runId?: string;
    }>;
    private parseOutputContent;
}
declare class OutputSerializer {
    serialize(output: CellOutput): string;
    updateWorkflowOutput(content: string, output: CellOutput): string;
}
declare class TemplateInterpolator {
    interpolate(content: string, outputs: Map<string, CellOutput>): string;
    interpolateAsync(content: string, outputs: Map<string, CellOutput>, readNote: (path: string) => Promise<string>): Promise<string>;
}
declare class ParserError extends Error {
    readonly line: number;
    constructor(message: string, line: number);
}
declare const parser: WorkflowParser;
declare const serializer: OutputSerializer;
declare const interpolator: TemplateInterpolator;

export { OutputSerializer, ParserError, TemplateInterpolator, WorkflowParser, interpolator, parser, serializer };
