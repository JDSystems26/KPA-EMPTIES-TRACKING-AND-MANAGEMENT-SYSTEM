(function () {
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var selectors = [
        '.mag-section-head', '.mag-lede', '.status-cell', '.advisory-card',
        '.network-card', '.mag-contact-card'
    ];
    var targets = document.querySelectorAll(selectors.join(','));

    if (reduceMotion || !('IntersectionObserver' in window)) {
        targets.forEach(function (el) { el.classList.add('in-view'); });
        return;
    }

    targets.forEach(function (el, i) {
        el.classList.add('reveal-target');
        el.style.transitionDelay = (i % 6) * 0.05 + 's';
    });

    var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                entry.target.classList.add('in-view');
                io.unobserve(entry.target);
            }
        });
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });

    targets.forEach(function (el) { io.observe(el); });
})();