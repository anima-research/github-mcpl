/**
 * MCPL SPEC §5.3, §5.4: `effectiveCapabilities` is the only allowlist, and a
 * path it doesn't name is denied; `deniedCapabilities` is diagnostic and never
 * authorizes. Nothing is granted before the first grant-bearing
 * `featureSets/update` Request.
 */

import {
  capabilityGranted,
  deriveFeatureSets,
  emptyGrantState,
  featureSetSelected,
  grantFromUpdate,
  isCapabilityPath,
  validateUses,
  type CapabilityGrantState,
  type FeatureSetDeclaration,
  type FeatureSetsUpdateParams,
  type UnavailableFeature,
} from '@animalabs/mcpl-core';
import { McplRpcError } from './errors.js';
import { featureSetForTool } from './types.js';

/** SPEC §6.7 — the response to `featureSets/update` is a degradation receipt. */
export interface DegradationReceipt {
  accepted: true;
  /** Omitted when nothing degraded (§6.7). */
  mode?: 'degraded';
  unavailableFeatures: UnavailableFeature[];
  notes: string[];
}

export class CapabilityGrant {
  private state: CapabilityGrantState = emptyGrantState();

  constructor(private declarations: Record<string, FeatureSetDeclaration> = {}) {}

  /** Declarations aren't authority (MCPL §6.4), so this widens nothing. */
  setDeclarations(declarations: Record<string, FeatureSetDeclaration>): void {
    this.declarations = declarations;
  }

  /** A new connection starts with no grant (MCPL §5.3). */
  reset(): void {
    this.state = emptyGrantState();
  }

  /** True once a grant-bearing `featureSets/update` Request has been accepted. */
  isReady(): boolean {
    return this.state.ready;
  }

  /**
   * Is `path` in the effective grant? False before the initial policy
   * exchange, and false for any path the host did not name.
   */
  has(path: string): boolean {
    if (!this.state.ready) return false;
    return capabilityGranted(this.state.effectiveCapabilities, path);
  }

  /** Is a declared feature set currently active? */
  isFeatureSetActive(name: string): boolean {
    if (!this.state.ready) return false;
    if (!featureSetSelected(this.state, name)) return false;
    return this.missingFor(name).length === 0;
  }

  /**
   * Did the host *select* this feature set — i.e. not disable it (§6.7) —
   * whatever its declared `uses` derive to?
   *
   * Selection and activity differ for a set whose surfaces are gated per
   * capability rather than per set: `github.events` declares `uses:
   * ['pushEvents']`, so it is inactive under a channels-only grant, and yet a
   * `channels/incoming` delivery is still granted. The pipeline asks this
   * first, so a host that turned github.events off gets neither path, and
   * asks `isFeatureSetActive` for the push it declared.
   */
  isFeatureSetSelected(name: string): boolean {
    if (!this.state.ready) return false;
    return featureSetSelected(this.state, name);
  }

  /** Capability paths a declared feature set needs but has not been granted. */
  missingFor(name: string): string[] {
    const decl = this.declarations[name];
    if (!decl) return [];
    return decl.uses.filter((use) => !this.has(use));
  }

  /**
   * May a `tools/call` for `toolName` run? `tools` has to be granted, and the
   * github feature set that owns the tool has to be active. A tool no feature
   * set claims is not reachable: absence is the denial (§5.4).
   */
  toolAllowed(toolName: string): boolean {
    if (!this.has('tools')) return false;
    const featureSet = featureSetForTool(toolName);
    if (!featureSet) return false;
    return this.isFeatureSetActive(featureSet);
  }

  /**
   * A host disables a feature set whose `uses` is absent, empty or not a
   * capability path, with reason `invalid_uses` (MCPL §6.2, §6.4).
   */
  invalidDeclarations(): Array<{ featureSet: string; unrecognized: string[] }> {
    return Object.entries(this.declarations)
      .map(([featureSet, decl]) => ({ featureSet, check: validateUses(decl?.uses) }))
      .filter(({ check }) => !check.valid)
      .map(({ featureSet, check }) => ({ featureSet, unrecognized: check.unrecognized }));
  }

  /**
   * MCPL §5.4: a policy naming a path in both `effectiveCapabilities` and
   * `deniedCapabilities` is malformed, and the grant fails closed: it holds
   * nothing and isn't ready. §6.7: only a Request can change the effective
   * grant, so a Notification applies only its `disabled` reductions.
   */
  apply(
    params: FeatureSetsUpdateParams,
    form: 'request' | 'notification' = 'request',
  ): DegradationReceipt {
    const result = grantFromUpdate(this.state, params, form);
    const notes: string[] = [];

    if (result.malformed) {
      this.state = result.state;
      throw new McplRpcError(
        -32602,
        'Malformed policy: capability appears in both effectiveCapabilities and deniedCapabilities',
        { capabilities: result.conflicts },
      );
    }

    if (form === 'request' && params.effectiveCapabilities === undefined) {
      // MCPL §5.4: an absent `effectiveCapabilities` is the empty allowlist.
      notes.push(
        'No effectiveCapabilities in featureSets/update; treating the grant as empty (SPEC 0.5 §5.4).',
      );
    }

    if (form === 'notification') {
      if (result.discarded.length > 0) {
        notes.push(
          `featureSets/update arrived as a Notification; ignored ${result.discarded.join(', ')} — ` +
            'a Notification cannot establish or alter the grant (SPEC 0.5 §6.7). Only `disabled` was applied.',
        );
      }
      if (!result.state.ready) {
        notes.push(
          'featureSets/update arrived as a Notification before the initial policy exchange; a Notification cannot establish a ready state (SPEC 0.5 §6.7), so no capability is in force.',
        );
      }
    }

    const unrecognized = (params.effectiveCapabilities ?? []).filter(
      (p) => typeof p === 'string' && !p.includes('*') && !isCapabilityPath(p),
    );
    if (form === 'request' && unrecognized.length > 0) {
      notes.push(`Ignoring capability paths outside the §6.2 vocabulary: ${unrecognized.join(', ')}`);
    }

    this.state = result.state;

    const derivation = deriveFeatureSets(this.declarations, this.state.effectiveCapabilities);
    const unavailableFeatures: UnavailableFeature[] = Object.entries(derivation.disabled).map(
      ([featureSet, why]) => ({
        featureSet,
        missingCapabilities: why.missingCapabilities as UnavailableFeature['missingCapabilities'],
        effect: 'disabled',
      }),
    );
    for (const [featureSet, why] of Object.entries(derivation.disabled)) {
      // Not the host's policy: our own declaration is unusable (§6.4).
      if (why.reason === 'invalid_uses') {
        notes.push(
          `Feature set ${featureSet} declares an invalid \`uses\` and is disabled (SPEC 0.5 §6.4)` +
            (why.missingCapabilities.length > 0
              ? `; outside the §6.2 vocabulary: ${why.missingCapabilities.join(', ')}`
              : ''),
        );
      }
    }

    return {
      accepted: true,
      ...(unavailableFeatures.length > 0 ? { mode: 'degraded' as const } : {}),
      unavailableFeatures,
      notes,
    };
  }
}
