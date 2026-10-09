function formatPrice(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function readTotal(cart) {
  return cart.summary.total;
}

function renderCart(cart) {
  var label = formatPrice(readTotal(cart));
  return 'Total: ' + label;
}

globalThis.renderCart = renderCart;
