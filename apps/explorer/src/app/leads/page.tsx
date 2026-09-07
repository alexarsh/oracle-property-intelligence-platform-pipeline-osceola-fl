import { OSCEOLA } from "@osceola/shared";
import { PageHeader } from "@/components/ui";
import { LeadsExplorer } from "@/components/LeadsExplorer";

export const dynamic = "force-dynamic";

export default function LeadsPage() {
  return (
    <>
      <PageHeader
        title="Roofing leads explorer"
        transcript="Using the UI, show properties within a sample radius that have roofs older than 15 years."
      >
        <div className="text-right text-xs text-zinc-500">
          <div>Click the map to drop a pin, or pick a demo place.</div>
          <div>
            Two MCP queries per search: properties in radius, then roofing permits on those parcels.
          </div>
        </div>
      </PageHeader>
      <LeadsExplorer
        places={OSCEOLA.places.map((p) => ({ ...p }))}
        defaults={{ ...OSCEOLA.thresholds }}
        bbox={{ ...OSCEOLA.bbox }}
      />
    </>
  );
}
