<script lang="ts">
  let { data } = $props();
</script>

<main class="mx-auto max-w-3xl p-8">
  <header class="mb-6 flex items-center justify-between">
    <h1 class="text-2xl font-semibold">Workflows</h1>
    <a class="rounded bg-black px-3 py-1.5 text-sm text-white" href="/workflows/new">New</a>
  </header>

  {#if data.workflows.length === 0}
    <p class="text-sm text-neutral-500">
      No workflows yet. Drop a .yaml file in the configured directory or click New.
    </p>
  {:else}
    <ul class="divide-y rounded border">
      {#each data.workflows as wf (wf.id)}
        <li class="flex items-center justify-between px-4 py-2">
          <span>{wf.name}</span>
          <a
            class="text-sm text-blue-600 hover:underline"
            href={`/workflows/${encodeURIComponent(wf.id)}`}
          >
            Open
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</main>
