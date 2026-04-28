<script lang="ts">
  import { goto } from '$app/navigation';

  let id = $state('untitled.yaml');
  let yaml = $state(`document:
  dsl: '1.0.0'
  namespace: default
  name: untitled
  version: '0.1.0'
do:
  - first:
      set:
        message: 'hello'
`);
  let saving = $state(false);
  let errMsg: string | null = $state(null);

  async function save() {
    saving = true;
    errMsg = null;
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, yaml }),
    });
    saving = false;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      errMsg = body.error ?? `HTTP ${res.status}`;
      return;
    }
    await goto(`/workflows/${encodeURIComponent(id)}`);
  }
</script>

<main class="mx-auto max-w-3xl space-y-4 p-8">
  <h1 class="text-2xl font-semibold">New workflow</h1>
  <label class="block text-sm">
    <span class="block">File name</span>
    <input class="mt-1 w-full rounded border px-2 py-1" bind:value={id} />
  </label>
  <label class="block text-sm">
    <span class="block">YAML</span>
    <textarea
      class="mt-1 h-72 w-full rounded border p-2 font-mono text-xs"
      bind:value={yaml}
    ></textarea>
  </label>
  {#if errMsg}<p class="text-sm text-red-600">{errMsg}</p>{/if}
  <button
    class="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
    disabled={saving}
    onclick={save}
  >
    {saving ? 'Saving…' : 'Create'}
  </button>
</main>
