import type { AgentTool } from "./types";

/**
 * Tool catalog the HSW agent can call. Execution is client-side: `runAgent`
 * forwards the model's tool_use blocks unchanged and the page state setters run
 * them in the browser. Keep descriptions explicit so the model picks the right
 * tool from a short user brief.
 */
export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "set_rectangle_shape",
    description: "Set the wall shape to a rectangle with the given width and height in millimetres. Use for plain rectangular walls.",
    input_schema: {
      type: "object",
      properties: {
        width: { type: "number", description: "Wall width in mm. Minimum 40." },
        height: { type: "number", description: "Wall height in mm. Minimum 40." },
      },
      required: ["width", "height"],
    },
  },
  {
    name: "set_regular_polygon_shape",
    description: "Set the wall shape to a regular polygon (equilateral) with N sides of equal length.",
    input_schema: {
      type: "object",
      properties: {
        sides: { type: "integer", description: "Number of sides, minimum 3 (triangle), e.g. 6 for hexagon." },
        side_length: { type: "number", description: "Side length in mm. Minimum 20." },
      },
      required: ["sides", "side_length"],
    },
  },
  {
    name: "set_vertex_polygon_shape",
    description: "Set the wall shape to an arbitrary polygon defined by an explicit list of vertices. Coordinates in mm, counter-clockwise, do not repeat the closing vertex.",
    input_schema: {
      type: "object",
      properties: {
        vertices: {
          type: "array",
          description: "Polygon vertices as [x, y] pairs in mm.",
          items: {
            type: "array",
            items: { type: "number" },
            minItems: 2,
            maxItems: 2,
          },
          minItems: 3,
        },
      },
      required: ["vertices"],
    },
  },
  {
    name: "set_plate_preset",
    description: "Pick one of the predefined printer plates. Valid ids: a1mini, bambu256, kobras1, mk4, mini, ender3, voron350.",
    input_schema: {
      type: "object",
      properties: {
        preset_id: {
          type: "string",
          enum: ["a1mini", "bambu256", "kobras1", "mk4", "mini", "ender3", "voron350"],
          description: "Printer preset id.",
        },
      },
      required: ["preset_id"],
    },
  },
  {
    name: "set_custom_plate",
    description: "Define a custom rectangular print bed with the given dimensions in mm.",
    input_schema: {
      type: "object",
      properties: {
        width: { type: "number", description: "Bed width in mm." },
        height: { type: "number", description: "Bed height in mm." },
      },
      required: ["width", "height"],
    },
  },
  {
    name: "set_margin",
    description: "Set the bed-edge clearance kept around every tile, in millimetres.",
    input_schema: {
      type: "object",
      properties: {
        margin: { type: "number", description: "Margin in mm. 0 packs to the very edge." },
      },
      required: ["margin"],
    },
  },
  {
    name: "set_clip_variant",
    description: "Set the default variant for every cell of every CLIP cluster (vertical-seam clusters, bridges). The variant decides what each cell looks like inside: 'empty' (hex cavity, original look), 'solid' (no cavity, just the clip body), 'hollow' (Ø10 mm cylindrical cavity for hooks), 'm3'/'m4'/'m5' (clip with embedded nut for screwing accessories), 'countersunk-m3'/'countersunk-m4'/'countersunk-m5' (clip that doubles as a wall mount). Per-cell overrides are still possible via the UI.",
    input_schema: {
      type: "object",
      properties: {
        variant: {
          type: "string",
          enum: [
            "empty",
            "solid",
            "hollow",
            "m3",
            "m4",
            "m5",
            "countersunk-m3",
            "countersunk-m4",
            "countersunk-m5",
          ],
          description: "Default cell variant for clip clusters.",
        },
      },
      required: ["variant"],
    },
  },
  {
    name: "set_mount_variant",
    description: "Set the default variant for WALL MOUNTS (the inserts that screw the panel to a wall). Typically 'countersunk-m3' (M3 socket-head countersunk, default), 'countersunk-m4', 'countersunk-m5'. Other variants are accepted but only the countersunk ones actually fix the panel to the wall.",
    input_schema: {
      type: "object",
      properties: {
        variant: {
          type: "string",
          enum: [
            "empty",
            "solid",
            "hollow",
            "m3",
            "m4",
            "m5",
            "countersunk-m3",
            "countersunk-m4",
            "countersunk-m5",
          ],
          description: "Default cell variant for wall mounts.",
        },
      },
      required: ["variant"],
    },
  },
  {
    name: "set_merge_mounts",
    description: "Toggle the 'merge wall mounts into clip clusters' option. When ON (default), a wall mount that falls on a cluster cell becomes a single combined part (the cluster cell gets the M3 countersunk hole), so one printed piece both locks the seam and screws the panel to the wall. Turn OFF if you want every wall mount as a standalone piece.",
    input_schema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "true to merge, false to keep wall mounts standalone.",
        },
      },
      required: ["enabled"],
    },
  },
  {
    name: "set_wall_mounts",
    description: "Set how many countersunk M3 wall-mount inserts hold the WHOLE panel against the wall (counted globally, not per tile). Use 'auto' (default; 1 if longest side <200 mm, else max(2, ceil(longest/400 mm)) — the structural minimum) or a fixed non-negative integer. The auto count is meant to be the bare minimum to hang the panel; users can bump it up to add perimeter support.",
    input_schema: {
      type: "object",
      properties: {
        total: {
          oneOf: [
            { type: "string", enum: ["auto"] },
            { type: "integer", minimum: 0 },
          ],
          description: "Total wall-mount inserts on the whole panel, or 'auto'.",
        },
      },
      required: ["total"],
    },
  },
  {
    name: "set_seam_inserts",
    description: "Set how many 3-cell horizontal-cluster clip inserts are placed on each VERTICAL seam. Each cluster has one full grip cell in the left tile, a bisected cell on the seam, and one full grip cell in the right tile — that's what actually locks the joint. Use 'auto' (default; 2 clusters per X-junction, 1 at the centre of a seam without crossings), 0 (none), or a fixed count (1, 2, 3, or 5 evenly distributed).",
    input_schema: {
      type: "object",
      properties: {
        per_seam: {
          oneOf: [
            { type: "string", enum: ["auto"] },
            { type: "integer", enum: [0, 1, 2, 3, 5] },
          ],
          description: "Clip inserts per vertical seam, or 'auto'.",
        },
      },
      required: ["per_seam"],
    },
  },
  {
    name: "set_bridges",
    description: "Set how many 2-cell bridge inserts cross each horizontal seam (clip inserts that lock two tiles vertically). Use 'auto' (default; max(1, ceil(seamLength / 200 mm))), 0 (no bridges, leaves the seam unlocked), or a fixed count (1, 2, 3, or 5 evenly spaced).",
    input_schema: {
      type: "object",
      properties: {
        per_seam: {
          oneOf: [
            { type: "string", enum: ["auto"] },
            { type: "integer", enum: [0, 1, 2, 3, 5] },
          ],
          description: "Bridge inserts per horizontal seam, or 'auto'.",
        },
      },
      required: ["per_seam"],
    },
  },
  {
    name: "set_material_profile",
    description: "Set the print-material profile that drives cellHoleExpansion on the PANEL cell hole (front, rear and pocket) to compensate for print-material shrinkage / over-extrusion so an original RostaP insert (or one printed in a different material) still fits at design clearance. Presets: 'PETG' (0 mm/side, RostaP native, no comp — use when panel and insert share material), 'PLA' (+0.15 mm/side, compensates typical PLA over-extrusion), 'ABS' (-0.05 mm/side, offsets ABS post-cool contraction), or 'custom' with an explicit expansion value in mm/side. Insert geometry is never scaled.",
    input_schema: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          enum: ["PETG", "PLA", "ABS", "custom"],
          description: "Material profile name; 'custom' requires expansion.",
        },
        expansion: {
          type: "number",
          description: "Custom expansion in mm/side, typical range -0.5 .. +0.5. Only read when profile is 'custom'.",
        },
      },
      required: ["profile"],
    },
  },
  {
    name: "set_border",
    description: "Toggle the solid frame around the honeycomb and set its thickness. When disabled the panel edge follows the cells.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "true to add a frame, false for cell-edged panel." },
        thickness: { type: "number", description: "Frame thickness in mm. Ignored when enabled is false. Minimum 1.8 (one wall thickness)." },
      },
      required: ["enabled", "thickness"],
    },
  },
];

/** Names the frontend can dispatch. */
export type AgentToolName = (typeof AGENT_TOOLS)[number]["name"];
