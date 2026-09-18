const slides=[...document.querySelectorAll('.slide')];
function current(){let best=0,dist=Infinity;slides.forEach((s,i)=>{const d=Math.abs(s.getBoundingClientRect().top);if(d<dist){best=i;dist=d;}});return best;}
addEventListener('keydown',async e=>{if(e.altKey||e.ctrlKey||e.metaKey||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
 let index=null;if(['ArrowRight','PageDown'].includes(e.key))index=Math.min(slides.length-1,current()+1);if(['ArrowLeft','PageUp'].includes(e.key))index=Math.max(0,current()-1);if(e.key==='Home')index=0;if(e.key==='End')index=slides.length-1;
 if(index!==null){e.preventDefault();slides[index].scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});}
 if(e.key.toLowerCase()==='f'&&document.documentElement.requestFullscreen){try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{}}
});
