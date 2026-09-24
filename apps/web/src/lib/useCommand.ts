import type { Accepted } from "@acct/types/Accepted";
import type { Command } from "@acct/types/Command";
import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { submitCommand } from "./api";
import { newId } from "./id";

/**
 * Submits commands, then invalidates `invalidates` so the screen shows the result straight away
 * (the sync feed catches everyone else's changes).
 */
export function useCommand(invalidates: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation<Accepted, Error, Command>({
    mutationFn: (command) => submitCommand(command, newId()),
    onSuccess: () => Promise.all(invalidates.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}
