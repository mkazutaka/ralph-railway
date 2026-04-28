<script lang="ts">
  import Graph from '$lib/flow/Graph.svelte';
  import { yamlToFlow } from '$lib/workflow/to-flow';

  let { data } = $props();
  let yaml = $state(data.yaml as string);
  let saving = $state(false);
  let saveMsg: string | null = $state(null);

  let parsed = $derived(yamlToFlow(yaml));

  async function save() {
    saving = true;
    saveMsg = null;
    const res = await fetch(`/api/workflows/${encodeURIComponent(data.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/yaml' },
      body: yaml,
    });
    saving = false;
    saveMsg = res.ok ? 'Saved' : `Error: HTTP ${res.status}`;
  }
</script>

<main class="grid h-screen grid-cols-2">
  <section class="flex flex-col border-r">
    <header class="flex items-center justify-between border-b px-4 py-2">
      <h1 class="text-sm font-medium">{data.id}</h1>
      <div class="flex items-center gap-3 text-xs">
        {#if saveMsg}<span class="text-neutral-500">{saveMsg}</span>{/if}
        <button
          class="rounded bg-black px-3 py-1 text-white disabled:opacity-50"
          disabled={saving}
          onclick={save}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </header>
    <textarea
      class="h-full flex-1 resize-none p-3 font-mono text-xs outline-none"
      bind:value={yaml}
    ></textarea>
    {#if parsed.error}
      <p class="border-t bg-red-50 px-3 py-1 text-xs text-red-700">{parsed.error}</p>
    {/if}
  </section>
  <section class="h-screen">
    <Graph nodes={parsed.nodes} edges={parsed.edges} />
  </section>
</main>
