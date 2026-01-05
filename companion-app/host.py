import sys
import json
import struct
import subprocess
import os
import threading

# Read a message from stdin
def get_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        return None
    message_length = struct.unpack('@I', raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    return json.loads(message)

# Send a message to stdout
def send_message(message):
    encoded_content = json.dumps(message).encode('utf-8')
    encoded_length = struct.pack('@I', len(encoded_content))
    sys.stdout.buffer.write(encoded_length)
    sys.stdout.buffer.write(encoded_content)
    sys.stdout.buffer.flush()

def download_video(data):
    url = data.get('url')
    filename = data.get('filename', 'video.mp4')
    headers = data.get('headers', {})
    
    # Sanitize filename
    safe_filename = "".join([c for c in filename if c.isalpha() or c.isdigit() or c in " ._-"]).rstrip()
    if not safe_filename: safe_filename = "video.mp4"
    
    # Determine output path (Downloads folder by default)
    user_home = os.path.expanduser("~")
    download_dir = os.path.join(user_home, "Downloads")
    output_path = os.path.join(download_dir, safe_filename)
    
    # Ensure unique filename
    base, ext = os.path.splitext(output_path)
    counter = 1
    while os.path.exists(output_path):
        output_path = f"{base}_{counter}{ext}"
        counter += 1

    # Prepare FFmpeg command
    # -y: Overwrite output files
    # -i: Input URL
    # -c copy: Stream copy (no re-encoding, fast)
    # -bsf:a aac_adtstoasc: Fix audio stream for TS to MP4
    cmd = ['ffmpeg', '-y']
    
    # Add headers if needed (User-Agent, Referer)
    ua = headers.get('User-Agent')
    referer = headers.get('Referer')
    cookie = headers.get('Cookie')
    
    if ua:
        cmd.extend(['-user_agent', ua])
    if referer or cookie:
        # FFmpeg uses -headers for some protocols, but for HTTP input standard flags are safer
        # or pass via -headers
        header_str = ""
        if referer: header_str += f"Referer: {referer}\r\n"
        if cookie: header_str += f"Cookie: {cookie}\r\n"
        if header_str:
            cmd.extend(['-headers', header_str])

    cmd.extend(['-i', url])
    cmd.extend(['-c', 'copy'])
    cmd.extend(['-bsf:a', 'aac_adtstoasc'])
    cmd.append(output_path)

    try:
        send_message({"status": "starting", "file": output_path})
        
        # Run FFmpeg
        process = subprocess.Popen(
            cmd, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            universal_newlines=True
        )
        
        # Wait for completion
        stdout, stderr = process.communicate()
        
        if process.returncode == 0:
            send_message({"status": "complete", "file": output_path})
        else:
            send_message({"status": "error", "error": stderr[-200:] if stderr else "Unknown FFmpeg error"})
            
    except Exception as e:
        send_message({"status": "error", "error": str(e)})

def main():
    while True:
        try:
            msg = get_message()
            if msg is None:
                break
            
            if msg.get('action') == 'DOWNLOAD':
                # Run download in a separate thread to not block the message loop
                # (Though for native hosts, Chrome usually keeps one pipe per connection)
                threading.Thread(target=download_video, args=(msg,)).start()
            elif msg.get('action') == 'PING':
                send_message({"status": "pong"})
                
        except Exception as e:
            send_message({"error": str(e)})
            break

if __name__ == '__main__':
    main()
