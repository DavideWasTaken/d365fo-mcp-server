/**
 * Get Map Info Tool
 * Reads an AxMap: the X++ map class (declaration, fields, methods) and the
 * tables it maps onto (with field-connection counts). The XML is parsed when
 * the file is reachable; the SQLite index serves the header, mapped tables and
 * a method-name fallback otherwise. Azure-safe READ tool.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import type { XppServerContext } from '../../types/context.js';
import { lookupSymbolNocase } from '../../utils/symbolLookup.js';
import { renderMethodSignature } from '../../metadata/xppDeclaration.js';
import { findD365FileOnDisk } from '../../utils/objectFileLookup.js';

const GetMapInfoArgsSchema = z.object({
  mapName: z.string().describe('Name of the AxMap object (e.g. "LogMap")'),
});

/** Ceiling on the rendered declaration — a map header is a few lines. */
const DECLARATION_PREVIEW_CHARS = 400;

export async function getMapInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const { mapName } = GetMapInfoArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.getReadDb();

    // Case-insensitive by AOT semantics, index-safe by construction (#686).
    const symbol = lookupSymbolNocase(db, mapName, ['map']);

    if (!symbol) {
      return {
        content: [{ type: 'text', text: `Map "${mapName}" not found.\n\nTip: run extract-metadata + build-database to index AxMap objects, or check the name with search(type="map").` }],
        isError: true,
      };
    }

    // Side table is keyed by the canonical name — pass symbol.name.
    const mappings = db.prepare(
      `SELECT mapping_table, field_connections FROM map_mappings WHERE map_name = ? ORDER BY mapping_table`
    ).all(symbol.name) as { mapping_table: string; field_connections: number }[];

    const lines: string[] = [];
    lines.push(`# AxMap: \`${symbol.name}\``);
    lines.push('');
    lines.push(`**Model:** ${symbol.model}`);
    if (symbol.extends_class) lines.push(`**Extends:** \`${symbol.extends_class}\``);
    lines.push(`**File:** \`${symbol.file_path}\``);
    lines.push('');

    // Parse the map's XML for declaration, fields and method signatures. The
    // indexed path may be relative (post-extract dumps) — resolve it against
    // the configured packages root when it is not readable as-is. A stale
    // index row or an unreachable file degrades to the header + whatever the
    // index holds, the same contract as classInfo's DB-only fallback.
    let mapData: {
      declaration?: string;
      fields?: { name: string; type: string; edt?: string; enumType?: string }[];
      methods?: { name: string; [k: string]: any }[];
    } | null = null;
    try {
      let mapPath: string | null = symbol.file_path ?? null;
      if (mapPath) {
        try {
          await fs.access(mapPath);
        } catch {
          mapPath = await findD365FileOnDisk('map', symbol.name, symbol.model ?? undefined);
        }
      } else {
        mapPath = await findD365FileOnDisk('map', symbol.name, symbol.model ?? undefined);
      }
      if (mapPath) {
        const result = await Promise.race([
          context.parser.parseMapFile(mapPath),
          new Promise<{ success: false; error: string }>(resolve =>
            setTimeout(() => resolve({ success: false, error: 'timeout' }), 3000)
          ),
        ]);
        if (result.success && result.data) mapData = result.data;
      }
    } catch {
      mapData = null;
    }

    if (mapData?.declaration) {
      const decl = mapData.declaration.slice(0, DECLARATION_PREVIEW_CHARS);
      lines.push('## Declaration');
      lines.push('');
      lines.push('```xpp');
      lines.push(decl);
      lines.push('```');
      lines.push('');
    }

    if (mapData?.fields?.length) {
      lines.push(`## Fields (${mapData.fields.length})`);
      lines.push('');
      lines.push('| Field | Type | EDT / Enum |');
      lines.push('|-------|------|------------|');
      for (const f of mapData.fields) {
        lines.push(`| \`${f.name}\` | ${f.type} | \`${f.edt || f.enumType || '—'}\` |`);
      }
      lines.push('');
    }

    // Prefer the parsed XML (signatures straight from the bodies); fall back
    // to method rows the index holds for this map's parent_name.
    let methods: { name: string; [k: string]: any }[] = mapData?.methods ?? [];
    let methodSource = '_Source: XML file parsing_';
    if (!methods.length) {
      methods = db.prepare(
        `SELECT name, signature FROM symbols WHERE type = 'method' AND parent_name = ? ORDER BY name`
      ).all(symbol.name) as { name: string; signature?: string }[];
      methodSource = '_Source: symbol index (XML unreachable — run extract-metadata to refresh)_';
    }

    lines.push(`## Methods (${methods.length})`);
    lines.push('');
    lines.push(methodSource);
    lines.push('');
    if (methods.length === 0) {
      lines.push('*(no methods declared)*');
    } else {
      for (const m of methods) {
        const sig = m.signature || renderMethodSignature(m as any);
        lines.push(`- ${sig}`);
      }
    }
    lines.push('');

    lines.push(`## Mapped tables (${mappings.length})`);
    lines.push('');
    if (mappings.length === 0) {
      lines.push('*(no table mappings indexed)*');
    } else {
      lines.push('| Table | Field connections |');
      lines.push('|-------|-------------------|');
      for (const m of mappings) {
        lines.push(`| \`${m.mapping_table}\` | ${m.field_connections} |`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error getting map info: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}
