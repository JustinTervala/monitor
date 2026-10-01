import type { ProviderId } from '../shared/types';
import openai from '../../assets/provider-icons/openai.svg';
import claude from '../../assets/provider-icons/claude.svg';

/** Decorative: the surrounding provider label supplies the accessible name. */
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

export function RowProviders({ providers }: { providers: ProviderId[] }) {
  const unique = [...new Set(providers)];
  const label = unique.map((provider) => (provider === 'codex' ? 'Codex' : 'Claude')).join(' + ');
  return (
    <span className="row-providers" role="img" aria-label={label} title={label}>
      {unique.map((provider) => (
        <ProviderIcon key={provider} provider={provider} />
      ))}
    </span>
  );
}
