# LinkedinAgent

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed on your machine
- A `.env` file with your required environment variables (see below)

## Quick Start

1. **Clone the repository**
   ```sh
   git clone https://github.com/NavuluriBalaji/Candidate-Sourcing.git
   cd LinkedinAgent
   ```

2. **Create a `.env` file**

   In the project root, create a file named `.env` and add:
   ```
   GEMINI_API_KEY=your_gemini_api_key
   LINKEDIN_USERNAME=your_linkedin_username
   LINKEDIN_PASSWORD=your_linkedin_password
   SERPER_API_KEY=your_serper_api_key
   ```

3. **Build the Docker image**
   ```sh
   docker build -t linkedin-agent .
   ```

4. **Run the Docker container**
   ```sh
   docker run -p 3000:3000 --env-file .env linkedin-agent
   ```

5. **Access the application**

   Open your browser and go to:  
   [http://localhost:3000/ui.html](http://localhost:3000/ui.html)

---

**Note:**  
- The `.env` file must be present and filled with valid credentials before running the container.
- No need to clone the repository; just pull and run the image.
- To stop the app, use Docker Desktop or run `docker ps` to find the container and `docker stop <container_id>`.

