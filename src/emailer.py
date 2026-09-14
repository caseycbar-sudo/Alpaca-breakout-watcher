from email.message import EmailMessage
import smtplib

from .config import Settings


def send_email(settings: Settings, subject: str, body: str) -> bool:
    if not (
        settings.email_from
        and settings.email_to
        and settings.gmail_app_password
    ):
        print(f"{subject}\n\n{body}")
        return False
    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = settings.email_to
    message["Subject"] = subject
    message.set_content(body)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
        smtp.login(settings.email_from, settings.gmail_app_password)
        smtp.send_message(message)
    return True
