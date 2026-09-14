from email.message import EmailMessage
import smtplib

from .config import Settings


def send_email(settings: Settings, subject: str, body: str) -> bool:
    sender = settings.email_from.strip()
    recipient = settings.email_to.strip()
    password = "".join(settings.gmail_app_password.split())
    if not (sender and recipient and password):
        print(f"{subject}\n\n{body}")
        return False
    message = EmailMessage()
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(body)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
        smtp.login(sender, password)
        smtp.send_message(message)
    return True
