import type { ProviderId } from '../shared/types';
import openai from '../../assets/provider-icons/openai.svg';
import claude from '../../assets/provider-icons/claude.svg';

/** Decorative: the adjacent provider or action label supplies the accessible name. */
export function ProviderIcon({ provider }: { provider: ProviderId }) {
  return (
    <img
      className="provider-icon"
      data-provider={provider}
      src={provider === 'codex' ? openai : claude}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
