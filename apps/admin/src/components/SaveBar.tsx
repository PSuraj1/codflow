import { useEffect, useState } from 'react';
import { Button, Card, InlineStack, Text } from '@shopify/polaris';
import { saveBarApi } from '../lib/appBridge';

/**
 * Unsaved-changes bar.
 *
 * Uses the admin's own save bar rather than Polaris's `ContextualSaveBar`,
 * which is what every screen in this app used to do and is why editing any
 * field blanked the app: `ContextualSaveBar` calls `useFrame()`, that throws
 * without a `<Frame>` ancestor, and this app has none — an embedded app is
 * supposed to let the admin render its chrome. The crash surfaced the moment a
 * form went dirty, which is to say on the first keystroke.
 *
 * `<ui-save-bar>` is a declaration, not the visible control: App Bridge renders
 * the real bar above the iframe and mirrors these buttons into it, which is why
 * the element is addressed by id and shown imperatively.
 *
 * The fallback is deliberate. If the save bar is unavailable — outside the
 * admin, or an App Bridge without it — the merchant would otherwise have no way
 * to save at all, and a form that cannot be submitted is worse than an
 * unstyled one.
 */

interface Props {
  /** Unique per screen. Two bars sharing an id would show each other's buttons. */
  id: string;
  dirty: boolean;
  loading?: boolean;
  /** Blocks the save without hiding the bar, for a draft that is not valid yet. */
  disabled?: boolean;
  message?: string;
  onSave: () => void;
  onDiscard: () => void;
}

export function SaveBar({
  id,
  dirty,
  loading = false,
  disabled = false,
  message = 'Unsaved changes',
  onSave,
  onDiscard,
}: Props) {
  // Read once: App Bridge is installed by a script tag before this renders, so
  // its presence cannot change while the component is mounted.
  const [available] = useState(() => saveBarApi() !== null);

  useEffect(() => {
    const api = saveBarApi();
    if (!api) return;

    // Rejections are ignored rather than surfaced: the only ones the API
    // produces are for a bar that is already in the requested state.
    if (dirty) {
      void api.show(id).catch(() => undefined);
    } else {
      void api.hide(id).catch(() => undefined);
    }
  }, [dirty, id]);

  useEffect(
    // Without this, navigating away mid-edit leaves the admin showing a save
    // bar wired to a screen that no longer exists.
    () => () => {
      void saveBarApi()?.hide(id).catch(() => undefined);
    },
    [id],
  );

  if (!available) {
    if (!dirty) return null;

    return (
      <Card>
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <Text as="p" variant="bodyMd">
            {message}
          </Text>
          <InlineStack gap="200">
            <Button onClick={onDiscard}>Discard</Button>
            <Button variant="primary" loading={loading} disabled={disabled} onClick={onSave}>
              Save
            </Button>
          </InlineStack>
        </InlineStack>
      </Card>
    );
  }

  return (
    <ui-save-bar id={id}>
      {/*
        Ordinary React buttons: they sit in this document, so React's own event
        delegation reaches them even though the admin paints their counterparts
        outside the frame. App Bridge fills in the labels.
      */}
      <button
        variant="primary"
        onClick={onSave}
        {...(loading ? { loading: 'true' } : {})}
        {...(disabled ? { disabled: true } : {})}
      />
      <button onClick={onDiscard} />
    </ui-save-bar>
  );
}
