import "dotenv/config";
import { pushIncidentCatalog } from "../integrations/opencti/push";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Ustaw zmienną " + name + ".");
  return value;
}

async function main() {
  const count = await pushIncidentCatalog({
    fonsBaseUrl: required("FONS_BASE_URL"),
    fonsToken: required("FONS_API_TOKEN"),
    collectionUrl: required("OPENCTI_TAXII_URL"),
    openctiToken: required("OPENCTI_TOKEN"),
    onAccepted: url => console.log("Status operacji TAXII — " + url.href),
  });
  console.log(count ? "OpenCTI potwierdził import obiektów: " + count + "." : "Katalog Fons jest pusty.");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Błąd eksportu do OpenCTI.");
  process.exitCode = 1;
});
