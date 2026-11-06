import { useContext } from 'react';
import { DEFAULT_UNIT_LABELS, type UnitLabels } from '../lib/format';
import { TenantContext } from '../lib/tenant';

/** Nomenclatura do condomínio atual; fora do TenantProvider (portal/totem), padrão Bloco/Apartamento. */
export const useUnitLabels = (): UnitLabels => useContext(TenantContext)?.unitLabels ?? DEFAULT_UNIT_LABELS;
