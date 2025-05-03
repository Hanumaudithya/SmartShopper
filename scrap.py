# scrap.py

import os
import time
import logging
from datetime import datetime
from typing import List, Dict, Any

from flask import Flask, request, jsonify, render_template, send_from_directory, send_file
from flask_pymongo import PyMongo
from werkzeug.security import generate_password_hash, check_password_hash
from flask_cors import CORS
from bson import ObjectId

import google.generativeai as genai
from dotenv import load_dotenv

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
from selenium.common.exceptions import TimeoutException

# ─── App & Logging Setup ───────────────────────────────────────────────────────
load_dotenv()
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("webdriver_manager").setLevel(logging.WARNING)

app = Flask(__name__, template_folder="templates", static_folder="static")
CORS(app)
app.config["MONGO_URI"] = os.getenv("MONGO_URI", "mongodb://localhost:27017/smartshopper")
mongo = PyMongo(app)

# ─── Gemini / Chatbot Setup ────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    gemini_model = genai.GenerativeModel(model_name="gemini-1.5-flash")
    chat_history: Dict[str, Any] = {}
    logging.info("Configured google-generativeai for Gemini")
else:
    gemini_model = None
    chat_history = {}
    logging.warning("GEMINI_API_KEY not set; using fallback chat")

# ─── Selenium Driver Management ────────────────────────────────────────────────
CACHE_DIR = os.getenv("WD_CACHE_DIR")
DRIVER_PATH = (ChromeDriverManager(cache_dir=CACHE_DIR).install()
               if CACHE_DIR else ChromeDriverManager().install())
logging.info(f"Using ChromeDriver at {DRIVER_PATH}")

def get_chrome_driver():
    opts = Options()
    opts.add_argument("--headless")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--window-size=1920,1080")
    # auto-allow geolocation
    opts.add_experimental_option("prefs", {
        "profile.default_content_setting_values.geolocation": 1
    })
    service = Service(DRIVER_PATH, log_path="chromedriver.log")
    return webdriver.Chrome(service=service, options=opts)

def scrape_from_quickcompare(driver, address: str, product: str) -> List[Dict[str, Any]]:
    driver.get("https://quickcompare.in/")
    wait = WebDriverWait(driver, 20)

    # set location if provided
    if address and address.lower() not in ("none", "none,None"):
        try:
            wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR,
                "button.flex.w-full.flex-col.px-4"))).click()
            time.sleep(1)
            inp = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR,
                "input[placeholder='Manually enter location']")))
            inp.clear()
            inp.send_keys(address)
            sugg = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR,
                "div.overflow-y-auto.px-4")))
            time.sleep(1)
            sugg.find_element(By.TAG_NAME, "button").click()
            time.sleep(3)
        except Exception:
            logging.exception("Failed to set location; continuing without it")

    # robustly find the search box
    try:
        search = wait.until(EC.element_to_be_clickable((
            By.CSS_SELECTOR,
            "form.relative.grow input[type=search], input[placeholder*='Search']"
        )))
    except TimeoutException:
        logging.exception("Search input not found – QuickCompare may have changed")
        return []

    search.clear()
    search.send_keys(product, Keys.ENTER)
    time.sleep(5)

    # grab all product cards
    cards = wait.until(EC.presence_of_all_elements_located((By.CSS_SELECTOR,
        "div.grid.grid-cols-2 > div.flex.flex-col")))
    results: List[Dict[str, Any]] = []

    for card in cards:
        try:
            name = card.find_element(By.CSS_SELECTOR,
                "div.line-clamp-2.text-start.text-sm.font-bold.text-text"
            ).text.strip()
            img_url = card.find_element(By.CSS_SELECTOR, "img.h-24").get_attribute("src")

            prices = []
            tiles = card.find_elements(By.CSS_SELECTOR, "div[style*='cursor: pointer']")
            for t in tiles:
                site_img = t.find_element(By.TAG_NAME, "img").get_attribute("src")
                platform = os.path.splitext(site_img.split("/")[-1])[0]

                mrp = t.find_element(By.CSS_SELECTOR, "span.line-through").text.strip() \
                      if t.find_elements(By.CSS_SELECTOR, "span.line-through") else "N/A"
                offer = t.find_element(By.CSS_SELECTOR, "span.font-bold").text.strip() \
                        if t.find_elements(By.CSS_SELECTOR, "span.font-bold") else "--"
                eta = t.find_element(By.CSS_SELECTOR, "svg + span").text.strip() \
                      if t.find_elements(By.CSS_SELECTOR, "svg + span") else "Closed"

                # updated quantity selector
                qty = ""
                if t.find_elements(By.CSS_SELECTOR, "div.text-sm.text-text-light"):
                    qty = t.find_element(By.CSS_SELECTOR,
                        "div.text-sm.text-text-light"
                    ).text.strip()

                prices.append({
                    "platform": platform,
                    "mrp": mrp,
                    "offer": offer,
                    "eta": eta,
                    "quantity": qty
                })

            results.append({
                "name": name,
                "image_url": img_url,
                "prices": prices
            })

        except Exception:
            logging.exception("Failed to parse one product card; skipping it")

    return results

def scrape_products(address: str, product: str) -> List[Dict[str, Any]]:
    driver = get_chrome_driver()
    try:
        return scrape_from_quickcompare(driver, address, product)
    finally:
        driver.quit()

def scrape_delivery_options(address: str) -> List[Dict[str, str]]:
    driver = get_chrome_driver()
    wait = WebDriverWait(driver, 20)
    out: List[Dict[str, str]] = []
    try:
        driver.get("https://quickcompare.in/")
        wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR,
            "button.flex.w-full.flex-col.px-4"))).click()

        addr_input = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR,
            "input[placeholder='Manually enter location']")))
        addr_input.clear()
        addr_input.send_keys(address)
        time.sleep(3)

        wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR,
            "div.overflow-y-auto.px-4 button"))).click()

        wait.until(EC.presence_of_all_elements_located((By.CSS_SELECTOR,
            "ul.no-scrollbar > li")))
        items = driver.find_elements(By.CSS_SELECTOR, "ul.no-scrollbar > li")

        for li in items:
            plat = li.find_element(By.TAG_NAME, "img").get_attribute("alt").strip()
            eta_el = li.find_elements(By.CSS_SELECTOR, "div.bg-bg p")
            eta = eta_el[0].text.strip() if eta_el else "Closed"
            out.append({"platform": plat, "eta": eta})

    except Exception:
        logging.exception("Delivery scrape failed")
    finally:
        driver.quit()

    return out

PLATFORM_LOGOS = {
    'zepto':      'https://d2chhaxkq6tvay.cloudfront.net/platforms/zepto.webp',
    'bigbasket':  'https://d2chhaxkq6tvay.cloudfront.net/platforms/bigbasket.webp',
    'swiggy':     'https://d2chhaxkq6tvay.cloudfront.net/platforms/swiggy.webp',
    'blinkit':    'https://d2chhaxkq6tvay.cloudfront.net/platforms/blinkit.webp',
    'dmartready': 'https://d2chhaxkq6tvay.cloudfront.net/platforms/dmart.webp',
    'jiomart':    'https://qcsearch.s3.ap-south-1.amazonaws.com/platforms/jiomart.webp',
}
DEFAULT_LOGO = 'https://your.cdn.com/platforms/default.webp'

@app.route('/api/delivery', methods=['GET'])
def get_delivery():
    address = request.args.get('address')
    if not address:
        return jsonify({'error': 'address required'}), 400

    raw = scrape_delivery_options(address)
    filtered = [e for e in raw if e.get('eta') and e['eta'].upper() != 'CLOSED']
    out = [
        {
            'platform': e['platform'],
            'eta':      e['eta'],
            'logo':     PLATFORM_LOGOS.get(e['platform'].lower(), DEFAULT_LOGO)
        }
        for e in filtered
    ]
    return jsonify(out), 200

@app.route('/api/search', methods=['POST'])
def search_products():
    data    = request.get_json(force=True)
    term    = (data.get('query') or "").strip()
    address = data.get('address','').strip()
    if not term:
        return jsonify([]), 200

    try:
        raw = scrape_products(address, term)
    except Exception:
        logging.exception(f"Product scrape failed for query={term!r}")
        return jsonify([]), 500

    out = []
    for product in raw:
        tiles = []
        for pr in product['prices']:
            key = pr['platform'].lower()
            tiles.append({
                'platform': pr['platform'],
                'logo':     PLATFORM_LOGOS.get(key, DEFAULT_LOGO),
                'mrp':      pr['mrp'],
                'offer':    pr['offer'],
                'eta':      pr['eta'],
                'quantity': pr.get('quantity','')
            })
        out.append({
            'name':      product['name'],
            'image_url': product['image_url'],
            'tiles':     tiles
        })

    return jsonify(out), 200

@app.route('/api/compare', methods=['POST'])
def compare():
    return search_products()

@app.route('/api/chat', methods=['POST'])
def chat():
    data = request.get_json(force=True)
    user_id = data.get('user_id', 'anon')
    msg = data.get('message','').strip()
    if not msg:
        return jsonify({'response':'Please say something.'}), 400
    try:
        if gemini_model:
            if user_id not in chat_history:
                chat_history[user_id] = gemini_model.start_chat()
                resp = chat_history[user_id].send_message(
                    f"SYSTEM: You are a helpful shopping assistant.\n\nUSER: {msg}"
                )
            else:
                resp = chat_history[user_id].send_message(msg)
            return jsonify({'response':resp.text}), 200
        else:
            m = msg.lower()
            if any(w in m for w in ['hello','hi']):     txt = "Hi there!"
            elif any(w in m for w in ['deal','offer']): txt = "Check our deals."
            else:                                       txt = "How can I assist?"
            return jsonify({'response':txt}), 200
    except Exception as e:
        return jsonify({'response':f'Error: {e}'}), 500

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/static/<path:path>')
def static_files(path):
    return send_from_directory('static', path)

@app.route('/api/placeholder/<int:w>/<int:h>')
def placeholder(w,h):
    from PIL import Image, ImageDraw, ImageFont
    buf = __import__('io').BytesIO()
    img = Image.new('RGB',(w,h),(240,240,240))
    d   = ImageDraw.Draw(img)
    d.rectangle([(0,0),(w-1,h-1)],outline=(200,200,200))
    try:
        font = ImageFont.truetype("arial.ttf",20)
    except:
        font = ImageFont.load_default()
    text = request.args.get('text','Product')
    tw,th = d.textsize(text,font=font)
    d.text(((w-tw)//2,(h-th)//2),text,fill=(80,80,80),font=font)
    img.save(buf,'JPEG')
    buf.seek(0)
    return send_file(buf,mimetype='image/jpeg')

@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json(force=True)
    for f in ('name','email','password'):
        if not data.get(f):
            return jsonify({'error':f"'{f}' is required"}),400
    if mongo.db.users.find_one({'email':data['email']}):
        return jsonify({'error':'Email already in use'}),409
    pw = generate_password_hash(data['password'])
    user = {'name':data['name'],'email':data['email'],'phone':data.get('phone',''),
            'password':pw,'created_at':datetime.utcnow()}
    res = mongo.db.users.insert_one(user)
    # ensure indexes
    mongo.db.searches.create_index([('location','2dsphere')])
    mongo.db.searches.create_index([('term',1)])
    mongo.db.searches.create_index([('timestamp',1)])
    return jsonify({'id':str(res.inserted_id)}),201

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json(force=True)
    user = mongo.db.users.find_one({'email':data.get('email')})
    if not user or not check_password_hash(user['password'],data.get('password','')):
        return jsonify({'error':'Invalid credentials'}),401
    return jsonify({
        'id':str(user['_id']),
        'name':user['name'],
        'email':user['email'],
        'phone':user.get('phone','')
    }),200

@app.route('/api/pantry', methods=['GET','POST'])
def pantry():
    if request.method=='GET':
        uid = request.args.get('user_id')
        if not uid:
            return jsonify({'error':'User ID is required'}),400
        items = list(mongo.db.pantry.find({'user_id':uid}))
        return jsonify(items),200
    data = request.get_json(force=True)
    if not data.get('user_id') or not data.get('name'):
        return jsonify({'error':'User ID and item name required'}),400
    item = {
        'user_id':data['user_id'],
        'name':data['name'],
        'expiry':data.get('expiry'),
        'quantity':data.get('quantity',1),
        'added_at':datetime.utcnow()
    }
    res = mongo.db.pantry.insert_one(item)
    return jsonify({'id':str(res.inserted_id)}),201

@app.route('/api/pantry/<item_id>', methods=['DELETE'])
def delete_pantry_item(item_id):
    try:
        res = mongo.db.pantry.delete_one({'_id':ObjectId(item_id)})
        if res.deleted_count:
            return jsonify({'success':True}),200
        return jsonify({'error':'Item not found'}),404
    except Exception as e:
        return jsonify({'error':str(e)}),500

if __name__ == '__main__':
    port = int(os.environ.get('PORT',5000))
    app.run(host='0.0.0.0',port=port,debug=True)
