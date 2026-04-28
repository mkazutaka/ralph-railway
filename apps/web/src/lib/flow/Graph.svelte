<script lang="ts">
  import { SvelteFlow, Background, Controls, type Node, type Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';

  let { nodes, edges }: { nodes: Node[]; edges: Edge[] } = $props();
</script>

<div class="h-full w-full">
  <SvelteFlow {nodes} {edges} fitView>
    <Background />
    <Controls />
  </SvelteFlow>
</div>
