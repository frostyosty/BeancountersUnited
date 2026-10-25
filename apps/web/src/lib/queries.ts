import type { Account } from "@acct/types/Account";
import type { AssetClassView } from "@acct/types/AssetClassView";
import type { BusinessView } from "@acct/types/BusinessView";
import type { ClientClassView } from "@acct/types/ClientClassView";
import type { ClientDetail } from "@acct/types/ClientDetail";
import type { ClientSummary } from "@acct/types/ClientSummary";
import type { JournalView } from "@acct/types/JournalView";
import type { LibraryParagraph } from "@acct/types/LibraryParagraph";
import type { MappingDetail } from "@acct/types/MappingDetail";
import type { PracticeView } from "@acct/types/PracticeView";
import type { TaxPosition } from "@acct/types/TaxPosition";
import type { TemplateDetail } from "@acct/types/TemplateDetail";
import type { UserView } from "@acct/types/UserView";
import type { YearAssets } from "@acct/types/YearAssets";
import type { YearLayoutView } from "@acct/types/YearLayoutView";
import type { YearNoteView } from "@acct/types/YearNoteView";
import type { YearSummary } from "@acct/types/YearSummary";
import type { YearTrialBalance } from "@acct/types/YearTrialBalance";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "./api";

/**
 * Query keys. The first element names what was read, and the second is the client or year it
 * belongs to, so the sync feed can invalidate by client or year.
 */
export const keys = {
  practice: ["practice"] as const,
  users: ["users"] as const,
  clients: ["clients"] as const,
  client: (id: string) => ["client", id] as const,
  chart: (clientId: string) => ["chart", clientId] as const,
  /** Everything read about years. A journal in one year changes the opening balances of the
   * years after it, so commands that post journals invalidate this whole prefix. */
  years: ["year"] as const,
  year: (id: string) => ["year", id] as const,
  journals: (yearId: string) => ["year", yearId, "journals"] as const,
  tb: (yearId: string) => ["year", yearId, "tb"] as const,
  report: (yearId: string) => ["year", yearId, "report"] as const,
  assets: (yearId: string) => ["year", yearId, "assets"] as const,
  /** Which template and mapping versions a year uses, and what moving it would change. */
  layout: (yearId: string, mappingId: string | null) => ["year", yearId, "layout", mappingId ?? ""] as const,
  /** A year's own copies of library paragraphs (M15). */
  notes: (yearId: string) => ["year", yearId, "notes"] as const,
  /** The practice paragraph library: everything, one entity type's, and a push preview. */
  paragraphs: ["paragraph-library"] as const,
  paragraphLibrary: (entityType: string) => ["paragraph-library", entityType] as const,
  pushPreview: (paragraphId: string) => ["paragraph-library", "push", paragraphId] as const,
  /** Practice asset classes; with a client id, as that client sees them. */
  assetClasses: ["asset-classes"] as const,
  clientAssetClasses: (clientId: string) => ["asset-classes", clientId] as const,
  /** Statement templates and mappings: one's latest version. Saving either changes both. */
  layouts: ["layouts"] as const,
  template: (id: string) => ["layouts", "template", id] as const,
  mapping: (id: string) => ["layouts", "mapping", id] as const,
  /** A business (M10): its settings and bank accounts, and its tax figure. */
  business: (clientId: string) => ["business", clientId] as const,
  tax: (clientId: string) => ["business", clientId, "tax"] as const,
};

export function usePractice() {
  return useQuery({ queryKey: keys.practice, queryFn: () => getJson<PracticeView>("/api/practice") });
}

export function useClients() {
  return useQuery({ queryKey: keys.clients, queryFn: () => getJson<ClientSummary[]>("/api/clients") });
}

export function useClient(id: string) {
  return useQuery({ queryKey: keys.client(id), queryFn: () => getJson<ClientDetail>(`/api/clients/${id}`) });
}

export function useChart(clientId: string) {
  return useQuery({ queryKey: keys.chart(clientId), queryFn: () => getJson<Account[]>(`/api/clients/${clientId}/chart`) });
}

export function useYear(id: string) {
  return useQuery({ queryKey: keys.year(id), queryFn: () => getJson<YearSummary>(`/api/years/${id}`) });
}

export function useJournals(yearId: string) {
  return useQuery({ queryKey: keys.journals(yearId), queryFn: () => getJson<JournalView[]>(`/api/years/${yearId}/journals`) });
}

export function useTrialBalance(yearId: string) {
  return useQuery({ queryKey: keys.tb(yearId), queryFn: () => getJson<YearTrialBalance>(`/api/years/${yearId}/tb`) });
}

export function useUsers() {
  return useQuery({ queryKey: keys.users, queryFn: () => getJson<UserView[]>("/api/users") });
}

export function useAssetClasses() {
  return useQuery({ queryKey: keys.assetClasses, queryFn: () => getJson<AssetClassView[]>("/api/asset-classes") });
}

export function useClientAssetClasses(clientId: string) {
  return useQuery({
    queryKey: keys.clientAssetClasses(clientId),
    queryFn: () => getJson<ClientClassView[]>(`/api/clients/${clientId}/asset-classes`),
  });
}

export function useYearAssets(yearId: string) {
  return useQuery({ queryKey: keys.assets(yearId), queryFn: () => getJson<YearAssets>(`/api/years/${yearId}/assets`) });
}

export function useBusiness(clientId: string) {
  return useQuery({ queryKey: keys.business(clientId), queryFn: () => getJson<BusinessView>(`/api/businesses/${clientId}`) });
}

export function useTax(clientId: string) {
  return useQuery({ queryKey: keys.tax(clientId), queryFn: () => getJson<TaxPosition>(`/api/businesses/${clientId}/tax`) });
}

export function useYearNotes(yearId: string) {
  return useQuery({ queryKey: keys.notes(yearId), queryFn: () => getJson<YearNoteView[]>(`/api/years/${yearId}/notes`) });
}

export function useParagraphLibrary(entityType: string) {
  return useQuery({
    queryKey: keys.paragraphLibrary(entityType),
    queryFn: () => getJson<LibraryParagraph[]>(`/api/paragraph-library/${entityType}`),
    enabled: entityType !== "",
  });
}

export function useTemplate(id: string) {
  return useQuery({ queryKey: keys.template(id), queryFn: () => getJson<TemplateDetail>(`/api/templates/${id}`) });
}

export function useMapping(id: string) {
  return useQuery({ queryKey: keys.mapping(id), queryFn: () => getJson<MappingDetail>(`/api/mappings/${id}`) });
}

/** The move preview for a year: onto the latest versions of `mappingId`, or of its own mapping. */
export function useYearLayout(yearId: string, mappingId: string | null) {
  const query = mappingId ? `?mapping_id=${encodeURIComponent(mappingId)}` : "";
  return useQuery({
    queryKey: keys.layout(yearId, mappingId),
    queryFn: () => getJson<YearLayoutView>(`/api/years/${yearId}/layout${query}`),
  });
}
