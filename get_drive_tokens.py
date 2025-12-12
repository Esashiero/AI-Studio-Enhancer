
import os
import json
import sys

# Try to import required libraries
try:
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:
    print("❌ Missing required libraries.")
    print("Please run: pip install google-auth-oauthlib")
    sys.exit(1)

# The scope required by the Userscript
SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

def get_client_secret_file():
    """Finds the first .json file in the current directory that looks like a Google client secret."""
    # Matches files like: client_secret_2_260866146875-....json
    files = [f for f in os.listdir('.') if f.startswith('client_secret') and f.endswith('.json')]
    
    if not files:
        print("❌ No 'client_secret_*.json' file found in this folder.")
        print("   1. Go to Google Cloud Console > APIs & Services > Credentials.")
        print("   2. Download the OAuth 2.0 Client ID JSON.")
        print("   3. Save it in this folder.")
        return None
    
    # If multiple found, ask user, otherwise pick first
    if len(files) > 1:
        print("Found multiple secret files:")
        for i, f in enumerate(files):
            print(f"[{i}] {f}")
        try:
            selection = int(input("Select file number: "))
            return files[selection]
        except:
            return files[0]
    
    return files[0]

def main():
    print("--- Google AI Studio UserScript Token Generator ---")
    
    # 1. Locate Client Secret
    secret_file = get_client_secret_file()
    if not secret_file:
        input("Press Enter to exit...")
        sys.exit(1)

    print(f"✅ Using file: {secret_file}")
    
    try:
        # 2. Initialize Auth Flow (Manual / Out-of-Band method)
        flow = InstalledAppFlow.from_client_secrets_file(
            secret_file, 
            SCOPES, 
            redirect_uri='urn:ietf:wg:oauth:2.0:oob'
        )

        # 3. Generate URL
        auth_url, _ = flow.authorization_url(prompt='consent')
        
        print("\n" + "="*60)
        print("1. Click the link below (or copy/paste it into a browser):")
        print(auth_url)
        print("="*60 + "\n")

        # 4. Get Code from User
        code = input('2. Enter the authorization code here: ').strip()
        
        # 5. Fetch Token
        flow.fetch_token(code=code)
        creds = flow.credentials

        # 6. Extract Raw Client Secret for the config
        with open(secret_file, 'r') as f:
            secret_data = json.load(f)
            # Google JSONs can be nested under 'installed' or 'web'
            key = 'installed' if 'installed' in secret_data else 'web'
            raw_client_secret = secret_data[key]['client_secret']

        print("\n" + "="*50)
        print("🎉 SUCCESS! COPY THE BLOCK BELOW INTO YOUR USER SCRIPT")
        print("="*50 + "\n")
        
        js_config = f"""const CONFIG = {{
    CLIENT_ID: "{creds.client_id}",
    CLIENT_SECRET: "{raw_client_secret}",
    REFRESH_TOKEN: "{creds.refresh_token}",
    FOLDER_NAME: "Google AI Studio",
    SYNC_INTERVAL_MINUTES: 15
}};"""
        
        print(js_config)
        print("\n" + "="*50)

    except Exception as e:
        print(f"\n❌ Error: {e}")
        print("Note: If you get a 'redirect_uri_mismatch' error, ensure your Google Cloud")
        print("Credentials are set to 'Desktop App' (formerly 'Other').")

    input("\nPress Enter to exit...")

if __name__ == '__main__':
    main()
