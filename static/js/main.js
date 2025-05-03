// static/js/main.js

// ——————————
// Global State
// ——————————
let currentUser   = JSON.parse(localStorage.getItem('user'))   || null;
let cart          = JSON.parse(localStorage.getItem('cart'))   || [];
let pantryItems   = JSON.parse(localStorage.getItem('pantry')) || [];
let loaderInterval, currentLogo = 0;
let userCoords    = { latitude: null, longitude: null };
let userAddress   = ''; // store reverse-geocoded address
const loaderLogos = [
  'https://d2chhaxkq6tvay.cloudfront.net/platforms/zepto.webp',
  'https://d2chhaxkq6tvay.cloudfront.net/platforms/bigbasket.webp',
  'https://d2chhaxkq6tvay.cloudfront.net/platforms/swiggy.webp',
  'https://d2chhaxkq6tvay.cloudfront.net/platforms/blinkit.webp',
  'https://d2chhaxkq6tvay.cloudfront.net/platforms/dmart.webp',
  'https://qcsearch.s3.ap-south-1.amazonaws.com/platforms/jiomart.webp'
];
let html5QrCode = null;  // scanner instance

// ——————————
// Grab key containers
// ——————————
const deliveryContainer = document.getElementById('deliveryContainer');
const productSection    = document.getElementById('productSection');

// ——————————
// Helpers: show/hide
// ——————————
function hide(el){ el.classList.add('hidden'); }
function show(el){ el.classList.remove('hidden'); }

// ——————————
// AUTH: Tab switching
// ——————————
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t,i)=>{
    t.classList.toggle('active', (tab==='login'&&i===0)||(tab==='register'&&i===1));
  });
  document.getElementById('loginForm').style.display    = tab==='login'    ? '' : 'none';
  document.getElementById('registerForm').style.display = tab==='register' ? '' : 'none';
}

// ——————————
// AUTH: Login / Register
// ——————————
async function handleLogin(e){
  e.preventDefault();
  const form = e.target;
  const email= form.loginPhoneEmail.value.trim();
  const pw   = form.loginPassword.value;
  try {
    let res = await fetch('/api/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({email,password:pw})
    });
    if(!res.ok) throw await res.json();
    currentUser = await res.json();
  } catch {
    currentUser = {name:'Demo User',email};
  }
  localStorage.setItem('user',JSON.stringify(currentUser));
  showDashboard();
  updateCart();
  updatePantryDisplay();
  getLocation();
  return false;
}

async function handleRegister(e){
  e.preventDefault();
  const fm = new FormData(e.target);
  const pwd = fm.get('password');
  if(!/^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d!@#$%^&*]).{6,}$/.test(pwd)){
    return showNotification('Password must be 6+ chars, upper/lower & digit/special','error');
  }
  try{
    await fetch('/api/register',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        name: fm.get('name').trim(),
        phone: fm.get('phone').trim(),
        email: fm.get('email').trim(),
        password: pwd
      })
    });
  }catch{}
  showNotification('Registration successful! Please log in.','success');
  switchAuthTab('login');
  e.target.reset();
  return false;
}

// ——————————
// Show Dashboard & populate profile
// ——————————
function showDashboard(){
  hide(document.getElementById('authContainer'));
  show(document.getElementById('dashboard'));
  if(currentUser){
    document.getElementById('userName').textContent  = currentUser.name;
    document.getElementById('userEmail').textContent = currentUser.email;
  }
}
function logout() {
  currentUser = null;
  localStorage.removeItem('user');
  document.getElementById('dashboard').style.display    = 'none';
  document.getElementById('authContainer').style.display = 'flex';
}

// ——————————
// LOCATION & DELIVERY
// ——————————
function getCurrentPositionPromise(){
  return new Promise((res,rej)=>{
    if(!navigator.geolocation) return rej();
    navigator.geolocation.getCurrentPosition(p=>res(p.coords),e=>rej(e));
  });
}
function getLocation(){
  navigator.geolocation.getCurrentPosition(pos=>{
    userCoords = pos.coords;
    fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`)
      .then(r=>r.json())
      .then(d=>{
        userAddress = d.display_name || '';
        document.getElementById('userLocation').textContent = userAddress;
        fetchDeliveryOptions();
      })
      .catch(()=>{
        document.getElementById('userLocation').textContent = 'N/A';
      });
  });
}

async function fetchDeliveryOptions(){
  try{
    const {latitude:lat,longitude:lng} = await getCurrentPositionPromise();
    userCoords = { latitude:lat, longitude:lng };
    let res = await fetch(`/api/delivery?address=${encodeURIComponent(userAddress)}`);
    if(!res.ok) throw '';
    let platforms = await res.json();
    document.getElementById('deliveryList').innerHTML = platforms.map(p=>`
      <li class="flex flex-col items-center p-2 bg-white rounded shadow">
        <img src="${p.logo}" alt="${p.platform}" class="w-12 h-12"/>
        <span class="text-sm mt-1">${p.eta}</span>
      </li>
    `).join('');
  }catch{
    console.warn('Delivery load failed');
  }
}

// ——————————
// LOADER
// ——————————
function startLoader(){
  const loader = document.getElementById('priceCompareLoader'),
        logo   = document.getElementById('loaderLogo'),
        bar    = document.getElementById('loaderBar');
  currentLogo = 0; logo.src = loaderLogos[0];
  bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = '';
  show(loader);
  loaderInterval = setInterval(()=>{
    currentLogo = (currentLogo+1) % loaderLogos.length;
    logo.src = loaderLogos[currentLogo];
  },1000);
}
function stopLoader(){
  clearInterval(loaderInterval);
  hide(document.getElementById('priceCompareLoader'));
}

// ——————————
// SEARCH & RENDER PRODUCTS
// ——————————
async function performSearch(query) {
  startLoader();
  hide(deliveryContainer);
  show(productSection);

  const grid  = document.getElementById('productGrid'),
        empty = document.getElementById('emptyState');
  grid.innerHTML = '';
  hide(empty);

  let data = [];
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, address: userAddress })
    });
    if (res.ok) {
      data = await res.json();
    } else {
      console.error('Search API error:', await res.text());
    }
  } catch (e) {
    console.error('Search failed:', e);
  } finally {
    stopLoader();
  }

  if (!data.length) {
    show(empty);
    return;
  }

  grid.innerHTML = data.map(p => `
    <div class="product-item flex flex-col gap-2 rounded-md bg-white p-4 shadow hover:shadow-md">
      <!-- Main product image -->
    <img
      class="h-32 w-full object-contain mb-2"
      src="${p.image_url || '/static/images/placeholder.png'}"
      alt="${p.name}"
      onerror="this.onerror=null; this.src='/static/images/logo1.png';"
    />


      <!-- Product name -->
      <div class="flex-1">
        <h3 class="text-xs text-gray-500 line-clamp-1">${p.name}</h3>
        <p class="text-sm font-bold text-gray-800 line-clamp-2">${p.name}</p>
      </div>

      <!-- Price tiles -->
      <div class="mt-4 space-y-4">
        ${p.tiles.map(tile => `
          <div class="price-tile cursor-pointer rounded border p-2 hover:bg-gray-50">
            <div class="flex items-center justify-between">
              <img
                class="h-5"
                src="${tile.logo || '/static/images/placeholder-logo.png'}"
                alt="${tile.platform}"
                onerror="this.src='/static/images/placeholder-logo.png'"
              />
              <div class="flex items-baseline gap-1">
                <span class="text-xs line-through text-gray-400">${tile.mrp}</span>
                <span class="font-semibold text-gray-900">${tile.offer}</span>
              </div>
            </div>
            <div class="flex items-center justify-between text-xs text-gray-500 mt-1">
              <span>${tile.quantity || ''}</span>
              <span class="flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"
                     viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"></path>
                  <path d="M12 7v5l3 3"></path>
                </svg>
                ${tile.eta}
              </span>
            </div>
            <button
              class="mt-3 w-full btn btn-sm btn-primary"
              onclick="addToCart(
                '${p.name.replace(/'/g,"\\'")}',
                '${tile.platform}',
                ${parseFloat(tile.offer.replace(/[^0-9.]/g,'')) || 0}
              )"
            >+</button>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}


// ——————————
// GRID / LIST VIEW TOGGLE
// ——————————
function changeView(view) {
  const grid = document.getElementById('productGrid');
  document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`.view-btn[onclick="changeView('${view}')"]`)
          .classList.add('active');
  grid.classList.toggle('list-view', view === 'list');
}

// ——————————
// SCANNER (html5-qrcode)
function startScanner(){
  const modal = document.getElementById('scannerModal');
  modal.style.display='flex';
  Html5Qrcode.getCameras()
    .then(devices=>{
      if(!devices.length) throw '';
      html5QrCode = new Html5Qrcode("reader");
      html5QrCode.start(
        {facingMode:"environment"},
        {fps:10,qrbox:{width:250,height:250}},
        decoded=>{
          html5QrCode.stop().then(()=>{
            modal.style.display='none';
            performSearch(decoded);
            html5QrCode.clear();
          });
        },
        ()=>{}
      ).catch(e=>{
        console.error(e);
        showNotification('Scanner failed','error');
        modal.style.display='none';
      });
    }).catch(e=>{
      console.error(e);
      showNotification('Camera access failed','error');
      modal.style.display='none';
    });
}
function stopScanner(){
  const modal = document.getElementById('scannerModal');
  modal.style.display='none';
  if(html5QrCode){
    html5QrCode.stop().then(()=>html5QrCode.clear()).catch(()=>{});
  }
}

// ——————————
// CHATBOT
function toggleChatbot(){
  const bot = document.getElementById('chatbot');
  bot.style.display = bot.style.display==='block'?'none':'block';
  if(bot.style.display==='block') document.getElementById('userInput').focus();
}
async function sendMessage(){
  const input = document.getElementById('userInput'),
        msgs  = document.getElementById('chatMessages'),
        txt   = input.value.trim();
  if(!txt) return;
  msgs.innerHTML += `<div class="message user-message">${txt}</div>`;
  input.value=''; msgs.scrollTop=msgs.scrollHeight;
  msgs.innerHTML += `<div class="message bot-message" id="typingIndicator">Typing<span class="dot-typing">...</span></div>`;
  msgs.scrollTop=msgs.scrollHeight;
  try {
    let res = await fetch('/api/chat',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({message:txt})
    });
    let {response} = await res.json();
    document.getElementById('typingIndicator').remove();
    msgs.innerHTML += `<div class="message bot-message">${response}</div>`;
  }catch{
    document.getElementById('typingIndicator').remove();
    msgs.innerHTML += `<div class="message bot-message">${getBotResponse(txt)}</div>`;
  }
  msgs.scrollTop=msgs.scrollHeight;
}
function getBotResponse(m){
  m=m.toLowerCase();
  if(/hello|hi|hey/.test(m)) return 'Hi there! How can I help you today?';
  if(/deal|offer/.test(m))     return 'Check out our latest deals!';
  return "Sorry, I didn't get that.";
}

// ——————————
// CART
function updateCart(){
  const list  = document.getElementById('cartItems'),
        empty = document.getElementById('emptyCart'),
        cnt   = document.getElementById('cartCount'),
        tot   = document.getElementById('cartTotal');
  cnt.textContent = cart.length;
  if(!cart.length){
    list.innerHTML=''; show(empty); tot.textContent='₹0'; return;
  }
  hide(empty);
  list.innerHTML = cart.map(i=>`
    <div class="cart-item flex justify-between">
      <span>${i.name}</span>
      <span>${i.platform}</span>
      <span>₹${i.price}</span>
      <button onclick="removeFromCart(${i.id})">×</button>
    </div>
  `).join('');
  tot.textContent='₹'+cart.reduce((s,i)=>s+i.price,0);
}
function addToCart(name,platform,price){
  cart.push({id:Date.now(),name,platform,price});
  localStorage.setItem('cart',JSON.stringify(cart));
  updateCart();
  showNotification(`Added "${name}" to cart`,'success');
}
function removeFromCart(id){
  cart = cart.filter(i=>i.id!==id);
  localStorage.setItem('cart',JSON.stringify(cart));
  updateCart();
}
function toggleCart(){
  document.getElementById('cartSection').classList.toggle('active');
}
function checkout(){
  if(!cart.length) return showNotification('Your cart is empty','warning');
  const sum = cart.reduce((s,i)=>s+i.price,0);
  showNotification(`Order placed! Total ₹${sum}`,'success');
  cart=[]; localStorage.setItem('cart','[]');
  updateCart(); toggleCart();
}

// ——————————
// PANTRY
function updatePantryDisplay(){
  const c=document.getElementById('pantryItems'),
        e=document.getElementById('emptyPantry');
  if(!pantryItems.length){ c.innerHTML=''; show(e); return; }
  hide(e);
  c.innerHTML = pantryItems.map(i=>{
    const days = i.expiry?Math.ceil((new Date(i.expiry)-new Date())/(1000*60*60*24)):null;
    const cls  = days<0?'expired':days<3?'expiring-soon':'';  
    return `
      <div class="pantry-item ${cls}">
        <span>${i.name} x${i.quantity}</span>
        <span>Expiry: ${i.expiry||'N/A'}</span>
        <button onclick="removePantryItem(${i.id})">🗑️</button>
      </div>
    `;
  }).join('');
}
function addPantryItem(){
  const n=document.getElementById('itemName').value.trim(),
        x=document.getElementById('expiryDate').value,
        q=parseInt(document.getElementById('itemQuantity').value)||1;
  if(!n) return showNotification('Enter item name','warning');
  pantryItems.push({id:Date.now(),name:n,expiry:x,quantity:q});
  localStorage.setItem('pantry',JSON.stringify(pantryItems));
  updatePantryDisplay();
  document.getElementById('itemName').value='';
  document.getElementById('expiryDate').value='';
  document.getElementById('itemQuantity').value='1';
}
function removePantryItem(id){
  pantryItems=pantryItems.filter(i=>i.id!==id);
  localStorage.setItem('pantry',JSON.stringify(pantryItems));
  updatePantryDisplay();
}
function sortPantry(by){
  pantryItems.sort((a,b)=>{
    if(by==='name') return a.name.localeCompare(b.name);
    if(!a.expiry) return 1;
    if(!b.expiry) return -1;
    return new Date(a.expiry)-new Date(b.expiry);
  });
  updatePantryDisplay();
}

// ——————————
// NOTIFICATIONS
function showNotification(msg,type='info'){
  const n=document.createElement('div');
  n.className=`notification notification-${type}`;
  n.innerHTML=msg;
  document.body.appendChild(n);
  setTimeout(()=>n.remove(),3000);
}

// ——————————
// PROFILE DROPDOWN
function toggleProfile(){
  const dropdown=document.getElementById('profileDropdown');
  dropdown.style.display=dropdown.style.display==='block'?'none':'block';
  if(dropdown.style.display==='block'){
    const closeDropdown=e=>{
      if(!e.target.closest('.user-profile')){
        dropdown.style.display='none';
        document.removeEventListener('click',closeDropdown,true);
      }
    };
    document.addEventListener('click',closeDropdown,true);
  }
}

// ——————————
// INITIAL WIRING
document.addEventListener('DOMContentLoaded',()=>{
  if(currentUser){
    showDashboard();
    updateCart();
    updatePantryDisplay();
    getLocation();
  }
  document.querySelector('.auth-tab:nth-child(1)').onclick=()=>switchAuthTab('login');
  document.querySelector('.auth-tab:nth-child(2)').onclick=()=>switchAuthTab('register');
  document.getElementById('loginForm').onsubmit=handleLogin;
  document.getElementById('registerForm').onsubmit=handleRegister;

  document.getElementById('openSidebar').onclick=()=>document.getElementById('sidebar').classList.add('active');
  document.getElementById('closeSidebar').onclick=()=>document.getElementById('sidebar').classList.remove('active');

  document.getElementById('searchBar').addEventListener('keydown',e=>{
    if(e.key==='Enter'){
      const q=e.target.value.trim();
      if(q) performSearch(q);
    }
  });
  document.getElementById('clearSearch').onclick=()=>{
    document.getElementById('searchBar').value='';
    hide(productSection);
    show(deliveryContainer);
  };

  document.querySelector('[onclick="startScanner()"]').addEventListener('click',startScanner);
  document.querySelector('[onclick="stopScanner()"]').addEventListener('click',stopScanner);

  document.getElementById('chatToggleBtn').onclick=toggleChatbot;
  document.getElementById('sendBtn').onclick=sendMessage;
  document.getElementById('userInput').addEventListener('keydown',e=>{ if(e.key==='Enter') sendMessage(); });

  document.querySelectorAll('.category-item').forEach(ci=>{
    ci.onclick=()=>{
      document.querySelectorAll('.category-item').forEach(x=>x.classList.remove('active'));
      ci.classList.add('active');
      if(window.innerWidth<768) document.getElementById('sidebar').classList.remove('active');
    };
  });
});
